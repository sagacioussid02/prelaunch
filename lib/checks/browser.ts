/**
 * Shared headless-browser session for the live simulations.
 *
 * One Chromium instance per scan, created lazily. Every request the browser
 * makes goes through the same SSRF guard as the HTTP scanner, so a page cannot
 * pull the scanner into internal addresses. If Chromium cannot be launched the
 * session is null and browser checks skip gracefully.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import type { ScanContext } from "./types.ts";
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

const UA_SUFFIX = " PreLaunchCheck/0.1";

async function launch(): Promise<Browser | null> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  // Bundled Chromium first, then an installed Google Chrome.
  try {
    return await chromium.launch({ headless: true });
  } catch {
    try {
      return await chromium.launch({ headless: true, channel: "chrome" });
    } catch {
      return null;
    }
  }
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
      page.on("console", (m) => {
        const t = m.text();
        if (m.type() === "error" && !t.startsWith("Failed to load resource")) consoleErrors.push(t.slice(0, 200));
      });
      page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 200)));
      page.on("request", (r) => {
        requestCount++;
        if (ctx.target.startsWith("https:") && r.url().startsWith("http:")) insecureRequests.push(r.url());
      });
      page.on("response", (r) => {
        bytes += Number(r.headers()["content-length"] ?? 0) || 0;
        if (r.status() >= 400) failedRequests.push({ url: r.url(), status: String(r.status()) });
      });
      page.on("requestfailed", (r) => {
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
      if (!navError) {
        const shot = await page.screenshot({ type: "jpeg", quality: 72 }).catch(() => null);
        if (shot) {
          await saveShot(ctx.scanId, vp, shot);
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
    ctx.session = launch().then((b) => (b ? createSession(b, ctx) : null));
  }
  return ctx.session as Promise<BrowserSession | null>;
}

export async function closeSession(ctx: ScanContext): Promise<void> {
  if (!ctx.session) return;
  const s = await (ctx.session as Promise<BrowserSession | null>).catch(() => null);
  await s?.close();
}
