/**
 * Shared headless-browser session for the live simulations.
 *
 * One Chromium instance per scan, created lazily. Every request the browser
 * makes goes through the same SSRF guard as the HTTP scanner, so a page cannot
 * pull the scanner into internal addresses.
 *
 * Launch resolution (issue #5 — stock Vercel functions ship no usable
 * Chromium, which used to silently skip every simulation):
 *   1. Serverless: `@sparticuz/chromium` + `playwright-core`, first when
 *      running on Vercel (`VERCEL` env) or forced via PRELAUNCH_BROWSER=
 *      serverless; also retried as a last resort when nothing local works.
 *   2. An operator-pinned binary (PRELAUNCH_CHROMIUM_PATH).
 *   3. Playwright's bundled Chromium (local dev after
 *      `npx playwright install chromium`), then an installed Chrome.
 * The outcome is explicit: getBrowserAvailability() reports which path won
 * or why all failed, so the report can mark the grade partial and show a
 * "browser checks unavailable" banner instead of skipping silently.
 * PRELAUNCH_BROWSER=off disables the browser entirely (kill switch, used
 * by scripts/test-browser.ts to exercise the unavailable path).
 */

import type { Browser, BrowserContext, Page, Request } from "playwright";
import type { BrowserAvailability, ScanContext } from "./types.ts";
import { assertSafeHostname } from "../ssrf.ts";
import { saveShot } from "../store.ts";

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, mobile: false, label: "Desktop · 1440×900" },
  tablet: { width: 820, height: 1180, mobile: true, label: "Tablet · 820×1180" },
  mobile: { width: 390, height: 844, mobile: true, label: "Phone · 390×844" },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

export interface FormInfo {
  action: string;
  method: string;
  hasSubmit: boolean;
  fields: Array<{ tag: string; type: string; name: string; required: boolean; hasPattern: boolean }>;
}

/**
 * One network response seen while loading a page, kept for the launch
 * traffic forecast (lib/surge): what each page view transfers and how the
 * CDN treats each resource. `bytes` is the encoded (on-the-wire) body size
 * from the browser, falling back to content-length when unavailable.
 */
export interface ResponseRecord {
  url: string;
  /** HTTP status; 0 for a same-origin request still open when the snapshot ended */
  status: number;
  /** Playwright resource type: document, script, stylesheet, image, fetch, xhr, font, ... */
  resourceType: string;
  sameOrigin: boolean;
  bytes: number;
  contentType: string;
  cacheControl: string;
  /** Vercel's x-vercel-cache value (HIT, MISS, BYPASS, STALE, PRERENDER, REVALIDATED), "" when absent */
  vercelCache: string;
  /** Generic CDN cache status (cf-cache-status / cache-status / x-cache), "" when absent */
  cdnCache: string;
  age: string;
  setsCookie: boolean;
}

/** Cap on stored response records per snapshot (keeps scan results small). */
export const MAX_RESPONSE_RECORDS = 300;

export interface PageSnapshot {
  viewport: ViewportName;
  status: number;
  finalUrl: string;
  loadMs: number;
  navError?: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{ url: string; status: string }>;
  insecureRequests: string[];
  requestCount: number;
  transferKB: number;
  /** Per-response records for the traffic forecast (first MAX_RESPONSE_RECORDS) */
  responses: ResponseRecord[];
  lcp: number | null;
  cls: number | null;
  scrollWidth: number;
  innerWidth: number;
  overflowX: boolean;
  hasViewportMeta: boolean;
  htmlLang: boolean;
  h1Count: number;
  textLength: number;
  brokenImages: string[];
  imgNoAlt: number;
  inputsNoLabel: number;
  buttonsNoName: number;
  smallTapTargets: number;
  tinyText: number;
  links: string[];
  forms: FormInfo[];
}

export interface VisitResult {
  url: string;
  status: number;
  loadMs: number;
  error?: string;
  pageErrors: string[];
  textLength: number;
}

export interface BrowserSession {
  snapshot(vp: ViewportName): Promise<PageSnapshot>;
  visit(url: string): Promise<VisitResult>;
  withPage<T>(vp: ViewportName, readOnly: boolean, fn: (page: Page) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Builds a ResponseRecord from lower-cased response headers. */
export function responseRecord(
  url: string,
  status: number,
  resourceType: string,
  sameOrigin: boolean,
  bytes: number,
  h: Record<string, string>,
): ResponseRecord {
  return {
    url: url.slice(0, 300),
    status,
    resourceType,
    sameOrigin,
    bytes,
    contentType: (h["content-type"] ?? "").split(";")[0].trim(),
    cacheControl: h["cache-control"] ?? "",
    vercelCache: (h["x-vercel-cache"] ?? "").toUpperCase(),
    cdnCache: h["cf-cache-status"] ?? h["cache-status"] ?? h["x-cache"] ?? "",
    age: h["age"] ?? "",
    setsCookie: "set-cookie" in h,
  };
}

// Issue #7: browser visits carry the same privacy/opt-out pointer as the
// HTTP fetcher's User-Agent (lib/checks/types.ts).
const UA_SUFFIX = " PreLaunchCheck/0.1 (+https://prelaunch-check.vercel.app/privacy)";

const LAUNCH_TIMEOUT_MS = 30_000;

interface LaunchOutcome {
  browser: Browser | null;
  availability: BrowserAvailability;
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split("\n")[0].slice(0, 160);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Serverless path: @sparticuz/chromium binary driven by playwright-core. */
async function launchServerless(): Promise<Browser> {
  const sparticuz = (await import("@sparticuz/chromium")).default as unknown as {
    args: string[];
    executablePath(): Promise<string>;
    setGraphicsMode?: boolean;
  };
  // SwiftShader software GL is enough for screenshots and far lighter.
  try {
    sparticuz.setGraphicsMode = false;
  } catch {
    /* property shape differs across majors; launch args already cover it */
  }
  const { chromium } = await import("playwright-core");
  const executablePath = await sparticuz.executablePath();
  return chromium.launch({
    args: sparticuz.args,
    executablePath,
    headless: true,
  }) as Promise<Browser>;
}

/** Local dev path: Playwright's bundled Chromium (playwright install). */
async function launchBundled(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}

/** Operator-pinned binary (also how CI images provide Chromium). */
async function launchEnvPath(path: string): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  // Container Chromium builds typically run without a usable sandbox.
  return chromium.launch({
    executablePath: path,
    headless: true,
    args: ["--no-sandbox"],
  }) as Promise<Browser>;
}

async function launchChromeChannel(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, channel: "chrome" });
}

async function attemptLaunch(): Promise<LaunchOutcome> {
  const mode = (process.env.PRELAUNCH_BROWSER ?? "").toLowerCase();
  if (mode === "off") {
    return {
      browser: null,
      availability: { state: "unavailable", reason: "browser disabled by PRELAUNCH_BROWSER=off" },
    };
  }
  const failures: string[] = [];
  const tryStep = async (label: string, fn: () => Promise<Browser>): Promise<Browser | null> => {
    try {
      return await withTimeout(fn(), LAUNCH_TIMEOUT_MS, label);
    } catch (err) {
      failures.push(`${label}: ${firstLine(err)}`);
      return null;
    }
  };

  const serverlessFirst = !!process.env.VERCEL || mode === "serverless";
  let browser: Browser | null = null;
  let via: string | null = null;

  if (serverlessFirst) {
    browser = await tryStep("serverless chromium", launchServerless);
    if (browser) via = "serverless (@sparticuz/chromium)";
  }
  if (!browser && process.env.PRELAUNCH_CHROMIUM_PATH) {
    browser = await tryStep("PRELAUNCH_CHROMIUM_PATH", () =>
      launchEnvPath(process.env.PRELAUNCH_CHROMIUM_PATH as string),
    );
    if (browser) via = "PRELAUNCH_CHROMIUM_PATH";
  }
  if (!browser) {
    browser = await tryStep("bundled chromium", launchBundled);
    if (browser) via = "bundled playwright chromium";
  }
  if (!browser) {
    browser = await tryStep("installed chrome", launchChromeChannel);
    if (browser) via = "installed Chrome (channel)";
  }
  if (!browser && !serverlessFirst) {
    // Last resort: the serverless binary also resolves off-Vercel.
    browser = await tryStep("serverless chromium", launchServerless);
    if (browser) via = "serverless (@sparticuz/chromium)";
  }

  if (browser && via) return { browser, availability: { state: "available", via } };
  return {
    browser: null,
    availability: {
      state: "unavailable",
      reason: `no Chromium could be launched (${failures.join("; ")})`,
    },
  };
}

/** One launch attempt per scan, shared by the session and availability. */
const launches = new WeakMap<ScanContext, Promise<LaunchOutcome>>();

function ensureLaunch(ctx: ScanContext): Promise<LaunchOutcome> {
  let p = launches.get(ctx);
  if (!p) {
    p = attemptLaunch();
    launches.set(ctx, p);
  }
  return p;
}

/**
 * Whether a browser could be started for this scan, and how (issue #5).
 * Shares the single launch attempt with getSession().
 */
export function getBrowserAvailability(ctx: ScanContext): Promise<BrowserAvailability> {
  return ensureLaunch(ctx).then((o) => o.availability);
}

async function guardContext(context: BrowserContext, readOnly: boolean): Promise<void> {
  const hostOk = new Map<string, Promise<boolean>>();
  await context.route("**/*", async (route) => {
    const req = route.request();
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return route.abort();
    }
    if (["data:", "blob:", "about:"].includes(u.protocol)) return route.continue();
    if (u.protocol !== "http:" && u.protocol !== "https:") return route.abort();
    // Journeys are read-only: no clicks may mutate the site under test.
    if (readOnly && !["GET", "HEAD", "OPTIONS"].includes(req.method())) {
      return route.abort("blockedbyclient");
    }
    let ok = hostOk.get(u.hostname);
    if (!ok) {
      ok = assertSafeHostname(u.hostname).then(() => true, () => false);
      hostOk.set(u.hostname, ok);
    }
    if (!(await ok)) return route.abort("blockedbyclient");
    return route.continue();
  });
}

/* Runs inside the page; must stay self-contained. */
function collectMetrics(isMobile: boolean) {
  const de = document.documentElement;
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const imgs = Array.from(document.images);
  const fields = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), select, textarea",
    ),
  ).filter(vis);
  const hasLabel = (el: HTMLInputElement) =>
    !!(
      el.getAttribute("aria-label") ||
      el.getAttribute("aria-labelledby") ||
      el.title ||
      el.closest("label") ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))
    );
  const named = (el: Element) =>
    !!(
      (el as HTMLElement).innerText?.trim() ||
      el.getAttribute("aria-label") ||
      el.getAttribute("aria-labelledby") ||
      el.getAttribute("title") ||
      el.querySelector("img[alt]:not([alt=''])")
    );
  const buttons = Array.from(document.querySelectorAll("button, [role=button]")).filter(vis);
  const tapTargets = Array.from(
    document.querySelectorAll("a[href], button, [role=button], input:not([type=hidden])"),
  ).filter((el) => {
    if (!vis(el)) return false;
    const r = el.getBoundingClientRect();
    const inline = getComputedStyle(el).display === "inline";
    return !inline && Math.min(r.width, r.height) < 24;
  });
  let tiny = 0;
  const textEls = Array.from(document.querySelectorAll("p, li, td, label, a, span, h1, h2, h3, h4"));
  for (const el of textEls.slice(0, 600)) {
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 3);
    if (hasText && vis(el) && parseFloat(getComputedStyle(el).fontSize) < 12) tiny++;
  }
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .filter((a) => a.origin === location.origin && /^https?:$/.test(a.protocol) && !a.hasAttribute("download"))
    .map((a) => a.origin + a.pathname + a.search);
  const forms = Array.from(document.forms)
    .slice(0, 5)
    .map((f) => ({
      action: f.getAttribute("action") ?? "",
      method: (f.method || "get").toLowerCase(),
      hasSubmit: !!f.querySelector("button:not([type=button]):not([type=reset]), input[type=submit]"),
      fields: Array.from(f.elements)
        .filter((e) => (e as HTMLInputElement).type !== "hidden" && ((e as HTMLInputElement).name || e.id))
        .slice(0, 15)
        .map((e) => {
          const i = e as HTMLInputElement;
          return {
            tag: e.tagName.toLowerCase(),
            type: i.type || e.tagName.toLowerCase(),
            name: i.name || e.id,
            required: !!i.required,
            hasPattern: !!i.pattern,
          };
        }),
    }));
  const pl = (window as unknown as { __pl?: { lcp: number; cls: number } }).__pl;
  return {
    scrollWidth: de.scrollWidth,
    innerWidth: window.innerWidth,
    overflowX: de.scrollWidth > window.innerWidth + 1,
    hasViewportMeta: !!document.querySelector("meta[name=viewport]"),
    htmlLang: !!de.getAttribute("lang"),
    h1Count: document.querySelectorAll("h1").length,
    textLength: (document.body?.innerText ?? "").trim().length,
    brokenImages: imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.currentSrc).map((i) => i.currentSrc).slice(0, 10),
    imgNoAlt: imgs.filter((i) => !i.hasAttribute("alt") && i.getAttribute("role") !== "presentation" && vis(i)).length,
    inputsNoLabel: fields.filter((f) => !hasLabel(f)).length,
    buttonsNoName: buttons.filter((b) => !named(b)).length,
    smallTapTargets: isMobile ? tapTargets.length : 0,
    tinyText: tiny,
    links: Array.from(new Set(links)).slice(0, 40),
    forms,
    lcp: pl?.lcp ?? null,
    cls: pl?.cls ?? null,
  };
}

function installVitals() {
  const w = window as unknown as { __pl: { lcp: number; cls: number } };
  w.__pl = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__pl.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as Array<{ hadRecentInput: boolean; value: number }>) {
        if (!e.hadRecentInput) w.__pl.cls += e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    /* observers unsupported */
  }
}

function createSession(browser: Browser, ctx: ScanContext): BrowserSession {
  const snapshots = new Map<ViewportName, Promise<PageSnapshot>>();

  async function withPage<T>(vp: ViewportName, readOnly: boolean, fn: (page: Page) => Promise<T>): Promise<T> {
    const v = VIEWPORTS[vp];
    const context = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      isMobile: v.mobile,
      hasTouch: v.mobile,
      deviceScaleFactor: 1,
      serviceWorkers: "block",
    });
    try {
      await guardContext(context, readOnly);
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      return await fn(page);
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function takeSnapshot(vp: ViewportName): Promise<PageSnapshot> {
    return withPage(vp, false, async (page) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const failedRequests: Array<{ url: string; status: string }> = [];
      const insecureRequests: string[] = [];
      let requestCount = 0;
      let bytes = 0;
      const origin = new URL(ctx.target).origin;
      page.on("console", (m) => {
        const t = m.text();
        if (m.type() === "error" && !t.startsWith("Failed to load resource")) consoleErrors.push(t.slice(0, 200));
      });
      page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 200)));
      // Same-origin requests still open when the snapshot ends (slow API
      // calls, a busy connection pool): recorded with status 0 so the
      // forecast still counts them as CDN requests.
      const open = new Set<Request>();
      page.on("request", (r) => {
        requestCount++;
        try {
          if (new URL(r.url()).origin === origin) open.add(r);
        } catch {
          /* data: and friends */
        }
        if (ctx.target.startsWith("https:") && r.url().startsWith("http:")) insecureRequests.push(r.url());
      });
      const responses: ResponseRecord[] = [];
      // Sizes are only known once a request finishes; collect the pending
      // lookups and settle them before the snapshot returns.
      const sizeLookups: Array<Promise<void>> = [];
      page.on("response", (r) => {
        if (r.status() >= 400) failedRequests.push({ url: r.url(), status: String(r.status()) });
      });
      page.on("requestfinished", (req) => {
        open.delete(req);
        sizeLookups.push(
          (async () => {
            const resp = await req.response().catch(() => null);
            if (!resp) return;
            const h = resp.headers();
            const declared = Number(h["content-length"] ?? 0) || 0;
            const sizes = await req.sizes().catch(() => null);
            const size = sizes && sizes.responseBodySize > 0 ? sizes.responseBodySize : declared;
            bytes += size;
            if (responses.length >= MAX_RESPONSE_RECORDS) return;
            let sameOrigin = false;
            try {
              sameOrigin = new URL(resp.url()).origin === origin;
            } catch {
              /* data: and friends */
            }
            responses.push(responseRecord(resp.url(), resp.status(), req.resourceType(), sameOrigin, size, h));
          })().catch(() => {}),
        );
      });
      page.on("requestfailed", (r) => {
        open.delete(r);
        const why = r.failure()?.errorText ?? "failed";
        if (!/ERR_ABORTED|BLOCKED_BY_CLIENT/.test(why)) failedRequests.push({ url: r.url(), status: why });
      });
      await page.addInitScript(installVitals);

      const t0 = Date.now();
      let status = 0;
      let navError: string | undefined;
      try {
        const resp = await page.goto(ctx.target, { waitUntil: "load", timeout: 20000 });
        status = resp?.status() ?? 0;
      } catch (err) {
        navError = String((err as Error).message ?? err).split("\n")[0];
      }
      const loadMs = Date.now() - t0;
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(400);

      const m = await page.evaluate(collectMetrics, VIEWPORTS[vp].mobile).catch(() => null);
      await Promise.all(sizeLookups);
      for (const r of open) {
        if (responses.length >= MAX_RESPONSE_RECORDS) break;
        responses.push(responseRecord(r.url(), 0, r.resourceType(), true, 0, {}));
      }
      if (!navError) {
        const shot = await page.screenshot({ type: "jpeg", quality: 72 }).catch(() => null);
        // A screenshot that can't be stored (e.g. no Blob store on a read-only
        // filesystem) is dropped; it must not fail the browser checks.
        const saved = shot ? await saveShot(ctx.scanId, vp, shot).then(() => true, () => false) : false;
        if (saved) {
          ctx.screenshots.push({ name: vp, label: VIEWPORTS[vp].label, width: VIEWPORTS[vp].width, height: VIEWPORTS[vp].height });
        }
      }
      return {
        viewport: vp,
        status,
        finalUrl: page.url(),
        loadMs,
        navError,
        consoleErrors,
        pageErrors,
        failedRequests,
        insecureRequests,
        requestCount,
        transferKB: Math.round(bytes / 1024),
        responses,
        scrollWidth: m?.scrollWidth ?? 0,
        innerWidth: m?.innerWidth ?? 0,
        overflowX: m?.overflowX ?? false,
        hasViewportMeta: m?.hasViewportMeta ?? true,
        htmlLang: m?.htmlLang ?? true,
        h1Count: m?.h1Count ?? 0,
        textLength: m?.textLength ?? 0,
        brokenImages: m?.brokenImages ?? [],
        imgNoAlt: m?.imgNoAlt ?? 0,
        inputsNoLabel: m?.inputsNoLabel ?? 0,
        buttonsNoName: m?.buttonsNoName ?? 0,
        smallTapTargets: m?.smallTapTargets ?? 0,
        tinyText: m?.tinyText ?? 0,
        links: m?.links ?? [],
        forms: m?.forms ?? [],
        lcp: m?.lcp ? Math.round(m.lcp) : null,
        cls: m?.cls != null ? Math.round(m.cls * 1000) / 1000 : null,
      };
    });
  }

  return {
    snapshot(vp) {
      let p = snapshots.get(vp);
      if (!p) {
        p = takeSnapshot(vp);
        snapshots.set(vp, p);
      }
      return p;
    },
    withPage,
    visit(url) {
      return withPage("desktop", true, async (page) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 200)));
        const t0 = Date.now();
        let status = 0;
        let error: string | undefined;
        try {
          const resp = await page.goto(url, { waitUntil: "load", timeout: 15000 });
          status = resp?.status() ?? 0;
        } catch (err) {
          error = String((err as Error).message ?? err).split("\n")[0];
        }
        const textLength = await page.evaluate(() => (document.body?.innerText ?? "").trim().length).catch(() => 0);
        return { url, status, loadMs: Date.now() - t0, error, pageErrors, textLength };
      });
    },
    async close() {
      await browser.close().catch(() => {});
    },
  };
}

/** Returns the scan's shared session, or null when no browser is available. */
export function getSession(ctx: ScanContext): Promise<BrowserSession | null> {
  if (!ctx.session) {
    ctx.session = ensureLaunch(ctx).then((o) => (o.browser ? createSession(o.browser, ctx) : null));
  }
  return ctx.session as Promise<BrowserSession | null>;
}

export async function closeSession(ctx: ScanContext): Promise<void> {
  if (!ctx.session) return;
  const s = await (ctx.session as Promise<BrowserSession | null>).catch(() => null);
  await s?.close();
}
