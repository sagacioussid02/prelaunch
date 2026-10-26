/**
 * Live browser simulations (category weight: 25).
 *
 * These open the target in real Chromium and behave like a visitor: render at
 * three screen sizes, watch for runtime errors, measure performance, audit the
 * live DOM, follow links, and generate user journeys from what the page
 * actually contains (forms, navigation, buttons).
 *
 * Passive mode is read-only: pages are loaded, forms are filled in the browser
 * but never submitted, and non-GET requests are blocked. Button clicking is
 * limited to owner (full) scans.
 */

import type { Check, Finding, ScanContext, Severity } from "./types.ts";
import { cachedGet } from "./types.ts";
import { getSession } from "./browser.ts";
import type { FormInfo, PageSnapshot } from "./browser.ts";

const CATEGORY = "Live browser simulation";
const WEIGHT = 25;
const SIM_TIMEOUT = 45_000;

function f(checkId: string, severity: Severity, title: string, location: string, fix: string, fixLink?: string): Finding {
  return { checkId, severity, title, location, fix, fixLink };
}

function short(u: string): string {
  try {
    const p = new URL(u);
    return p.host + p.pathname + p.search;
  } catch {
    return u;
  }
}

const NO_BROWSER = (id: string) =>
  f(
    id,
    "info",
    "Live browser simulations skipped: no Chromium available on the scanner",
    "scanner runtime",
    "Run `npx playwright install chromium` on the machine running the scanner.",
    "https://playwright.dev/docs/browsers",
  );

const simLoad: Check = {
  id: "sim-load",
  name: "Real browser load",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  timeoutMs: SIM_TIMEOUT,
  async run(ctx) {
    const session = await getSession(ctx);
    if (!session) return [NO_BROWSER("sim-load")];
    const s = await session.snapshot("desktop");
    const out: Finding[] = [];
    if (s.navError) {
      return [f("sim-load", "blocker", "The page failed to load in a real browser", ctx.target, `Browser reported: ${s.navError}`)];
    }
    if (s.status >= 400) out.push(f("sim-load", "blocker", `Home page returned HTTP ${s.status}`, ctx.target, "Make sure the production URL serves your app with a 200."));
    if (s.status < 400 && s.textLength < 20) {
      out.push(f("sim-load", "blocker", "Page renders blank (no visible text)", ctx.target, "Open the site in an incognito window; check hydration errors in the console."));
    }
    if (s.pageErrors.length) {
      out.push(f("sim-load", "warning", `${s.pageErrors.length} uncaught JavaScript error${s.pageErrors.length > 1 ? "s" : ""} on load`, s.pageErrors[0], "Fix the exception; uncaught errors often break interactivity."));
    }
    if (s.consoleErrors.length) {
      out.push(f("sim-load", "warning", `${s.consoleErrors.length} console error${s.consoleErrors.length > 1 ? "s" : ""} on load`, s.consoleErrors[0], "Open DevTools > Console and clear the errors before launch."));
    }
    const origin = new URL(ctx.target).origin;
    const own = s.failedRequests.filter((r) => r.url.startsWith(origin));
    if (own.length) {
      out.push(f("sim-load", "warning", `${own.length} of your own requests failed`, `${short(own[0].url)} (${own[0].status})`, "Check DevTools > Network for 4xx/5xx or missing assets."));
    } else if (s.failedRequests.length) {
      out.push(f("sim-load", "info", `${s.failedRequests.length} third-party request${s.failedRequests.length > 1 ? "s" : ""} failed`, `${short(s.failedRequests[0].url)} (${s.failedRequests[0].status})`, "Remove or fix dead third-party embeds."));
    }
    if (s.insecureRequests.length) {
      out.push(f("sim-load", "warning", "Page requests insecure http:// resources (mixed content)", short(s.insecureRequests[0]), "Serve every asset over https://."));
    }
    if (s.brokenImages.length) {
      out.push(f("sim-load", "warning", `${s.brokenImages.length} broken image${s.brokenImages.length > 1 ? "s" : ""}`, short(s.brokenImages[0]), "Fix the image path or remove the element."));
    }
    return out;
  },
};

const simMobile: Check = {
  id: "sim-mobile",
  name: "Mobile & tablet layout",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  timeoutMs: SIM_TIMEOUT,
  async run(ctx) {
    const session = await getSession(ctx);
    if (!session) return [];
    const [mobile, tablet] = await Promise.all([session.snapshot("mobile"), session.snapshot("tablet")]);
    const out: Finding[] = [];
    if (mobile.navError) return out;
    if (!mobile.hasViewportMeta) {
      out.push(f("sim-mobile", "warning", "Missing <meta name=\"viewport\">", ctx.target, "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">."));
    }
    for (const s of [mobile, tablet]) {
      if (s.overflowX) {
        out.push(f("sim-mobile", "warning", `Page scrolls sideways on ${s.viewport} (content ${s.scrollWidth}px wide in a ${s.innerWidth}px screen)`, ctx.target, "Find the element wider than the viewport (images, tables, fixed widths) and make it responsive."));
      }
    }
    if (mobile.smallTapTargets > 8) {
      out.push(f("sim-mobile", "warning", `${mobile.smallTapTargets} tap targets are smaller than 24px on phone`, ctx.target, "Give buttons and links at least 44×44px of tappable area.", "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html"));
    } else if (mobile.smallTapTargets > 0) {
      out.push(f("sim-mobile", "info", `${mobile.smallTapTargets} small tap target${mobile.smallTapTargets > 1 ? "s" : ""} on phone`, ctx.target, "Aim for 44×44px touch targets."));
    }
    if (mobile.tinyText > 5) {
      out.push(f("sim-mobile", "info", `${mobile.tinyText} text elements use a font under 12px`, ctx.target, "Use at least 14–16px for body text on mobile."));
    }
    return out;
  },
};

const simA11y: Check = {
  id: "sim-a11y",
  name: "Accessibility basics",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  timeoutMs: SIM_TIMEOUT,
  async run(ctx) {
    const session = await getSession(ctx);
    if (!session) return [];
    const s = await session.snapshot("desktop");
    if (s.navError) return [];
    const out: Finding[] = [];
    if (!s.htmlLang) out.push(f("sim-a11y", "warning", "<html> has no lang attribute", ctx.target, "Add lang=\"en\" (or your language) to the <html> tag."));
    if (s.imgNoAlt) out.push(f("sim-a11y", "warning", `${s.imgNoAlt} image${s.imgNoAlt > 1 ? "s" : ""} without alt text`, ctx.target, "Add alt text, or alt=\"\" for decorative images."));
    if (s.inputsNoLabel) out.push(f("sim-a11y", "warning", `${s.inputsNoLabel} form field${s.inputsNoLabel > 1 ? "s" : ""} without a label`, ctx.target, "Associate a <label for> or aria-label with each field."));
    if (s.buttonsNoName) out.push(f("sim-a11y", "warning", `${s.buttonsNoName} button${s.buttonsNoName > 1 ? "s" : ""} with no accessible name`, ctx.target, "Add visible text or aria-label to icon-only buttons."));
    if (s.h1Count === 0) out.push(f("sim-a11y", "info", "Page has no <h1> heading", ctx.target, "Add one descriptive <h1> per page."));
    if (s.h1Count > 1) out.push(f("sim-a11y", "info", `Page has ${s.h1Count} <h1> headings`, ctx.target, "Use a single <h1> and <h2>/<h3> beneath it."));
    return out;
  },
};

const simPerf: Check = {
  id: "sim-perf",
  name: "Performance vitals",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  timeoutMs: SIM_TIMEOUT,
  async run(ctx) {
    const session = await getSession(ctx);
    if (!session) return [];
    const s = await session.snapshot("desktop");
    if (s.navError) return [];
    const out: Finding[] = [];
    const loc = `${ctx.target} (desktop)`;
    if (s.lcp != null && s.lcp > 4000) out.push(f("sim-perf", "warning", `Largest Contentful Paint is ${(s.lcp / 1000).toFixed(1)}s (target under 2.5s)`, loc, "Optimize the hero image/font, use next/image and preload critical assets.", "https://web.dev/articles/lcp"));
    else if (s.lcp != null && s.lcp > 2500) out.push(f("sim-perf", "info", `Largest Contentful Paint is ${(s.lcp / 1000).toFixed(1)}s (target under 2.5s)`, loc, "Optimize the hero image/font and trim render-blocking scripts.", "https://web.dev/articles/lcp"));
    if (s.cls != null && s.cls > 0.25) out.push(f("sim-perf", "warning", `Layout shifts a lot while loading (CLS ${s.cls})`, loc, "Reserve space for images, ads and late-loading fonts.", "https://web.dev/articles/cls"));
    else if (s.cls != null && s.cls > 0.1) out.push(f("sim-perf", "info", `Some layout shift while loading (CLS ${s.cls})`, loc, "Set width/height on images and embeds.", "https://web.dev/articles/cls"));
    if (s.loadMs > 6000) out.push(f("sim-perf", "warning", `Page took ${(s.loadMs / 1000).toFixed(1)}s to fully load`, loc, "Check for large bundles, slow APIs or cold starts."));
    if (s.transferKB > 3000) out.push(f("sim-perf", "warning", `Page downloads about ${(s.transferKB / 1024).toFixed(1)} MB`, loc, "Compress images, code-split and drop unused dependencies."));
    if (s.requestCount > 100) out.push(f("sim-perf", "info", `Page makes ${s.requestCount} network requests`, loc, "Bundle or lazy-load assets to reduce requests."));
    return out;
  },
};

/** Regex fallback so link checks still run without a browser. */
function hrefsFromHtml(html: string, target: string): string[] {
  const origin = new URL(target).origin;
  const out = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], target);
      if (u.origin === origin) out.add(u.origin + u.pathname + u.search);
    } catch {
      /* skip */
    }
  }
  return Array.from(out);
}

const simLinks: Check = {
  id: "sim-links",
  name: "Link crawl",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  timeoutMs: SIM_TIMEOUT,
  async run(ctx) {
    const session = await getSession(ctx);
    let links: string[];
    if (session) {
      const s = await session.snapshot("desktop");
      links = s.links;
    } else {
      links = hrefsFromHtml((await cachedGet(ctx, ctx.target)).body, ctx.target);
    }
    links = links.filter((l) => l !== ctx.target && l !== ctx.target + "/").slice(0, 15);
    const results = await Promise.all(links.map(async (l) => ({ l, r: await cachedGet(ctx, l) })));
    const out: Finding[] = [];
    for (const { l, r } of results) {
      if (r.status === 0) out.push(f("sim-links", "warning", "Link did not respond", short(l), "Check the URL or remove the link."));
      else if (r.status >= 400) out.push(f("sim-links", "warning", `Broken link (HTTP ${r.status})`, short(l), "Fix or remove the link before launch."));
    }
    return out;
  },
};

/** Generates realistic test data for a form field from its type and name. */
function sampleValue(fieldType: string, name: string): string | null {
  const n = name.toLowerCase();
  if (["checkbox", "radio", "file", "submit", "button", "reset", "image", "select-one", "select-multiple"].includes(fieldType)) return null;
  if (fieldType === "email" || n.includes("email")) return "qa.bot@example.com";
  if (fieldType === "password") return "Test-Passw0rd!42";
  if (fieldType === "tel" || n.includes("phone")) return "+14155550123";
  if (fieldType === "url" || n.includes("website")) return "https://example.com";
  if (fieldType === "number") return "5";
  if (fieldType === "date") return "2030-01-15";
  if (n.includes("name")) return "Ada Lovelace";
  return "Hello from PreLaunch Check";
}

function formFindings(forms: FormInfo[], ctx: ScanContext): Finding[] {
  const out: Finding[] = [];
  forms.forEach((form, i) => {
    const label = `form #${i + 1}${form.action ? ` → ${short(form.action)}` : ""}`;
    const hasPassword = form.fields.some((x) => x.type === "password");
    const insecureAction = /^http:\/\//i.test(form.action) && ctx.target.startsWith("https:");
    if (insecureAction) out.push(f("sim-journeys", "blocker", "Form submits over plain HTTP", label, "Point the form action at an https:// URL."));
    if (hasPassword && form.method === "get") out.push(f("sim-journeys", "blocker", "Password form uses GET (credentials end up in the URL)", label, "Use method=\"post\"."));
    if (!form.hasSubmit && form.fields.length) out.push(f("sim-journeys", "info", "Form has no submit button", label, "Add a <button type=\"submit\"> so keyboard and mobile users can submit."));
    for (const fld of form.fields) {
      if (fld.type === "text" && /e-?mail/i.test(fld.name)) {
        out.push(f("sim-journeys", "info", `Field "${fld.name}" looks like an email but is type=text`, label, "Use type=\"email\" for built-in validation and the right mobile keyboard."));
      }
    }
  });
  return out;
}

const UNSAFE_BUTTON = /delete|remove|pay|buy|checkout|purchase|submit|sign\s?out|log\s?out|unsubscribe|cancel|send|subscribe|book/i;

const simJourneys: Check = {
  id: "sim-journeys",
  name: "Generated user journeys",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  timeoutMs: SIM_TIMEOUT,
  async run(ctx) {
    const session = await getSession(ctx);
    if (!session) return [];
    const s: PageSnapshot = await session.snapshot("desktop");
    if (s.navError) return [];
    const out: Finding[] = formFindings(s.forms, ctx);

    // Journey 1: visit the first few distinct pages the home page links to.
    const pages = s.links.filter((l) => l !== ctx.target && l !== ctx.target + "/").slice(0, 4);
    const visits = await Promise.all(pages.map((p) => session.visit(p).catch(() => null)));
    for (const v of visits) {
      if (!v) continue;
      if (v.error) out.push(f("sim-journeys", "warning", "Linked page failed to load in a browser", short(v.url), v.error));
      else if (v.status >= 400) out.push(f("sim-journeys", "warning", `Linked page returned HTTP ${v.status}`, short(v.url), "Fix the route or remove the link."));
      else if (v.textLength < 20) out.push(f("sim-journeys", "warning", "Linked page renders blank", short(v.url), "Check the page for runtime errors."));
      if (v.pageErrors.length) out.push(f("sim-journeys", "warning", "Linked page throws a JavaScript error", `${short(v.url)}: ${v.pageErrors[0]}`, "Fix the exception on this route."));
    }

    // Journey 2: fill each form with generated, type-appropriate data (never submitted).
    if (s.forms.length) {
      const invalid = await session.withPage("desktop", true, async (page) => {
        await page.goto(ctx.target, { waitUntil: "load", timeout: 15000 });
        return page.evaluate(
          (samples) => {
            const bad: string[] = [];
            Array.from(document.forms)
              .slice(0, 3)
              .forEach((form, i) => {
                for (const el of Array.from(form.elements) as HTMLInputElement[]) {
                  const v = samples[`${el.type}|${el.name || el.id}`];
                  if (v && !el.disabled && !el.readOnly) {
                    el.value = v;
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                  }
                }
                const requiredEmpty = (Array.from(form.elements) as HTMLInputElement[]).some(
                  (e) => e.required && ["checkbox", "radio", "file"].indexOf(e.type) === -1 && !e.value,
                );
                if (!requiredEmpty && !form.checkValidity()) bad.push(`form #${i + 1}`);
              });
            return bad;
          },
          Object.fromEntries(
            s.forms.flatMap((fm) =>
              fm.fields.flatMap((fld) => {
                const v = sampleValue(fld.type, fld.name);
                return v ? [[`${fld.type}|${fld.name}`, v]] : [];
              }),
            ),
          ),
        );
      }).catch(() => [] as string[]);
      for (const name of invalid) {
        out.push(f("sim-journeys", "warning", "Form rejects realistic test data", name, "Loosen the validation rules; a normal user could be blocked from submitting."));
      }
    }

    // Journey 3 (owner scans only): click safe buttons, watch for crashes.
    if (ctx.mode === "full") {
      const crashed = await session.withPage("desktop", true, async (page) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
        await page.goto(ctx.target, { waitUntil: "load", timeout: 15000 });
        const buttons = page.locator("button:not([type=submit]):visible");
        const n = Math.min(await buttons.count(), 5);
        for (let i = 0; i < n; i++) {
          const b = buttons.nth(i);
          const text = ((await b.innerText().catch(() => "")) || (await b.getAttribute("aria-label")) || "").trim();
          if (UNSAFE_BUTTON.test(text)) continue;
          await b.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(300);
        }
        return errors;
      }).catch(() => [] as string[]);
      if (crashed.length) out.push(f("sim-journeys", "warning", "Clicking buttons triggers a JavaScript error", crashed[0], "Reproduce by clicking the page's buttons and fix the handler."));
    }
    return out;
  },
};

export const simulationChecks: Check[] = [simLoad, simMobile, simA11y, simPerf, simLinks, simJourneys];
