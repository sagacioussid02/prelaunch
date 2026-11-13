/**
 * Launch traffic forecast (category "Launch traffic"). Passive.
 *
 * Asks "what does launch day do to this site?": how each key page is
 * cached, what one visitor costs the host, how many visitors Vercel's
 * Hobby plan absorbs before a monthly limit stops the site, and what the
 * same traffic costs on Pro.
 *
 * Measuring is milestone 1 (lib/surge/measure.ts: at most two sequential
 * GETs per route through the SSRF guard, plus the desktop browser snapshot
 * the other live checks already take). This check projects it
 * (lib/surge/model.ts) and grades it.
 *
 * The grade always uses the same launch size (DEFAULT_VISITORS visitors x
 * DEFAULT_PAGES_PER_VISITOR pages, on Hobby) so scans and deploy-monitor
 * diffs stay comparable; the full forecast is stored on the scan result
 * for the report to recompute at other sizes.
 */

import type { Check, Finding, ScanContext } from "./types.ts";
import { CheckNotRun, cachedGet } from "./types.ts";
import { getBrowserAvailability, getSession } from "./browser.ts";
import type { PageSnapshot } from "./browser.ts";
import { getSurgeMeasurement } from "../surge/measure.ts";
import type { ForecastInputs, Projection, ResourceForecast, SurgeForecast } from "../surge/model.ts";
import {
  DEFAULT_PAGES_PER_VISITOR,
  DEFAULT_VISITORS,
  forecastInputs,
  project,
  roughly,
} from "../surge/model.ts";
import type { Resource } from "../surge/pricing.ts";
import { PRICING_AS_OF, RESOURCES, VERCEL_HOBBY, VERCEL_PRO } from "../surge/pricing.ts";

const ID = "surge-forecast";
const CATEGORY = "Launch traffic";
const WEIGHT = 15;

/** Waits for the browser's links at most this long before measuring from the HTML instead. */
const LINKS_WAIT_MS = 25_000;
/** After measuring, wait at most this long for the snapshot's response records. */
const SNAPSHOT_WAIT_MS = 15_000;

const PRICING_LINK = "https://vercel.com/pricing";
const CACHE_LINK = "https://vercel.com/docs/caching/cache-status";

const LIMIT_FIX: Record<Resource, string> = {
  cdnRequests:
    "Cut requests per page view: give files in /public a long Cache-Control in next.config.ts headers(), inline or combine small icons, and lazy-load media below the fold.",
  fastDataTransfer:
    "Shrink the page: serve images through next/image at the size they are shown, compress or stream video, and drop unused JavaScript.",
  functionInvocations:
    "Serve pages from the CDN instead of a function: make them static or add `export const revalidate = 3600`, and send `Cache-Control: s-maxage=60` on API responses that are the same for everyone.",
  activeCpu:
    "Run fewer functions per visit: make content pages static or ISR (`export const revalidate = 3600`) and cache API responses at the CDN with s-maxage.",
  fastOriginTransfer:
    "Cache the large uncached responses at the CDN (ISR or `Cache-Control: s-maxage=...`) so functions don't resend them on every visit.",
  imageTransformations:
    "Use fewer image variants: set `sizes` on next/image, trim images.deviceSizes and imageSizes in next.config.ts, or serve already-sized files from /public.",
};

const ASSET_HEADERS_FIX =
  "Give static files a long cache in next.config.ts: `async headers() { return [{ source: '/:all*(svg|png|jpg|webp|avif|woff2|ico)', headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }] }] }`. Use `max-age=31536000, immutable` only for files whose name changes when their content does.";

function amount(resource: Resource, n: number): string {
  const unit = RESOURCES[resource].unit;
  if (unit === "GB") return `${n < 10 ? n.toFixed(1) : roughly(n)} GB`;
  if (unit === "hours") return `${n < 10 ? n.toFixed(1) : roughly(n)} hours`;
  return `${roughly(n)} ${unit}`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function f(severity: Finding["severity"], title: string, location: string, fix: string, fixLink?: string): Finding {
  return { checkId: ID, severity, title, location, fix, ...(fixLink ? { fixLink } : {}) };
}

/**
 * Turns a forecast into graded findings. Pure (exported for tests).
 *
 * - blocker: at the default launch size a Hobby limit runs out (Vercel sites)
 * - warning: a limit passes 50%; a page skips the CDN because of a cookie
 *   or BYPASS; several static files revalidate on every view; image
 *   transformations pass half the limit
 * - info: other uncached pages, slow first responses, partial data, and
 *   any limit finding for a site not hosted on Vercel
 */
export function forecastFindings(target: string, inputs: ForecastInputs, graded: Projection): Finding[] {
  const out: Finding[] = [];
  const onVercel = inputs.host === "vercel";
  const visitors = roughly(graded.visitors);
  const size = `${visitors} visitors viewing ${graded.pagesPerVisitor} pages each`;

  if (!onVercel) {
    out.push(
      f(
        "info",
        inputs.host === "unknown"
          ? "Launch forecast: hosting platform not recognised, so Vercel Hobby is used as a yardstick"
          : `Launch forecast: site runs on ${inputs.host[0].toUpperCase()}${inputs.host.slice(1)}, so Vercel Hobby is used as a yardstick`,
        target,
        "The cache findings apply on any host; for limits and costs, compare the per-visitor numbers in the forecast with your host's own plan.",
      ),
    );
  }

  const scaling = graded.rows.filter((r) => RESOURCES[r.resource].scalesWithVisitors && r.share != null);
  const over = scaling.filter((r) => (r.share ?? 0) >= 1).sort((a, b) => (a.capacityVisitors ?? 0) - (b.capacityVisitors ?? 0));
  const half = scaling.filter((r) => (r.share ?? 0) >= 0.5 && (r.share ?? 0) < 1);

  if (over.length) {
    const first: ResourceForecast = over[0];
    const also = over.slice(1).map((r) => r.label);
    out.push(
      f(
        onVercel ? "blocker" : "info",
        `At ${visitors} launch visitors, the site would pass Vercel Hobby's ${first.label} limit`,
        `${amount(first.resource, first.usage)} of ${amount(first.resource, first.included ?? 0)} a month for ${size}; ` +
          `the limit runs out at about ${roughly(first.capacityVisitors ?? 0)} visitors` +
          (also.length ? `. Also over: ${also.join(", ")}` : ""),
        `${LIMIT_FIX[first.resource]} Hobby can't buy more, so Vercel would limit the site for the rest of the month; on Pro the same traffic is billed instead.`,
        PRICING_LINK,
      ),
    );
  }
  if (half.length) {
    out.push(
      f(
        onVercel ? "warning" : "info",
        `At ${visitors} launch visitors, the site would use over half of Vercel Hobby's ${half.map((r) => r.label).join(" and ")}`,
        half.map((r) => `${r.label}: ${pct(r.share ?? 0)} (${amount(r.resource, r.usage)} of ${amount(r.resource, r.included ?? 0)})`).join("; "),
        LIMIT_FIX[half[0].resource],
        PRICING_LINK,
      ),
    );
  }

  const images = graded.rows.find((r) => r.resource === "imageTransformations");
  if (images?.share != null && images.share >= 0.5) {
    out.push(
      f(
        onVercel ? "warning" : "info",
        `One page alone uses ${pct(images.share)} of Vercel Hobby's monthly image transformations`,
        `${roughly(images.usage)} distinct optimized images on ${target}`,
        LIMIT_FIX.imageTransformations,
        "https://vercel.com/docs/image-optimization/limits-and-pricing",
      ),
    );
  }

  const uncached = inputs.routes.filter((r) => r.verdict === "uncached");
  const broken = uncached.filter((r) => r.cacheBreaker || /BYPASS/.test(r.reason));
  const other = uncached.filter((r) => !broken.includes(r));
  if (broken.length) {
    const r = broken[0];
    const why = r.cacheBreaker === "set-cookie" ? "sets a cookie" : r.cacheBreaker === "vary-cookie" ? "varies on cookies" : "bypasses the cache";
    out.push(
      f(
        "warning",
        broken.length === 1
          ? `A page skips the CDN cache because it ${why}, so a function runs on every visit`
          : `${broken.length} pages skip the CDN cache (cookies or BYPASS), so a function runs on every visit`,
        broken.map((x) => x.path).slice(0, 5).join(", "),
        "Content that is the same for every visitor shouldn't set or read cookies on the server: move `cookies()` and `headers()` out of shared layouts into the components that need them, set analytics or consent cookies in the browser, then add `export const revalidate = 3600` to the page.",
        CACHE_LINK,
      ),
    );
  }
  if (other.length) {
    out.push(
      f(
        "info",
        other.length === 1 ? "A page runs a function on every visit" : `${other.length} pages run a function on every visit`,
        other.slice(0, 5).map((x) => `${x.path} (${x.reason})`).join("; "),
        "Fine for pages that are different for each visitor. For pages that are the same for everyone, make them static or add `export const revalidate = 3600` so the CDN serves them.",
        CACHE_LINK,
      ),
    );
  }

  if (inputs.revalidatingAssetCount > 0) {
    const n = inputs.revalidatingAssetCount;
    out.push(
      f(
        n >= 3 ? "warning" : "info",
        `${n} static file${n > 1 ? "s are" : " is"} re-checked with the CDN on every page view`,
        inputs.revalidatingAssets.slice(0, 5).join(", "),
        ASSET_HEADERS_FIX,
        "https://nextjs.org/docs/app/api-reference/config/next-config-js/headers",
      ),
    );
  }

  const slow = inputs.routes.filter(
    (r) => r.verdict === "uncached" && r.ttfbMs >= 1500 && r.repeatTtfbMs != null && r.repeatTtfbMs <= r.ttfbMs / 2,
  );
  if (slow.length) {
    const r = slow[0];
    out.push(
      f(
        "info",
        `First response took ${(r.ttfbMs / 1000).toFixed(1)}s, then ${(r.repeatTtfbMs! / 1000).toFixed(1)}s (likely a cold start)`,
        r.path,
        "Launch spikes hit cold functions. Serving the page from the CDN avoids it; otherwise trim what the function imports at startup.",
      ),
    );
  }

  if (inputs.partial) {
    out.push(f("info", "Launch forecast is partial", target, inputs.partial));
  }
  return out;
}

function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

const surgeForecast: Check = {
  id: ID,
  name: "Launch traffic forecast",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  // Browser start (shared) + at most ~40s of sequential GETs + snapshot wait.
  timeoutMs: 90_000,
  async run(ctx: ScanContext): Promise<Finding[]> {
    const session = await getSession(ctx).catch(() => null);
    const snapshotP: Promise<PageSnapshot | null> = session
      ? session.snapshot("desktop").catch(() => null)
      : Promise.resolve(null);

    const measurement = await getSurgeMeasurement(ctx, async () => {
      const s = await within(snapshotP, LINKS_WAIT_MS);
      return s && !s.navError ? s.links : null;
    });
    const home = measurement.routes[0];
    if (!home || home.first.status === 0) {
      throw new CheckNotRun(
        `The site didn't answer (${home?.first.error ?? "no response"}), so there was no traffic to forecast.`,
      );
    }

    const snapshot = await within(snapshotP, SNAPSHOT_WAIT_MS);
    let noBrowserReason: string | undefined;
    if (!snapshot) {
      const avail = await getBrowserAvailability(ctx).catch(() => null);
      noBrowserReason = avail?.state === "unavailable" ? avail.reason : "the page snapshot wasn't ready in time";
    } else if (snapshot.navError) {
      noBrowserReason = `the page didn't load in the browser: ${snapshot.navError}`;
    }
    const usable = snapshot && !snapshot.navError ? snapshot : null;

    const inputs = forecastInputs({
      target: ctx.target,
      measurement,
      responses: usable ? usable.responses : null,
      ...(noBrowserReason ? { noBrowserReason } : {}),
      homeHtml: usable ? undefined : (await cachedGet(ctx, ctx.target)).body,
    });
    const graded = project(inputs, VERCEL_HOBBY, DEFAULT_VISITORS, DEFAULT_PAGES_PER_VISITOR);
    const forecast: SurgeForecast = {
      inputs,
      graded,
      pro: project(inputs, VERCEL_PRO, DEFAULT_VISITORS, DEFAULT_PAGES_PER_VISITOR),
      pricingAsOf: PRICING_AS_OF,
      measuredAt: measurement.measuredAt,
      requests: measurement.requests,
    };
    ctx.forecast = forecast;
    return forecastFindings(ctx.target, inputs, graded);
  },
};

export const surgeChecks: Check[] = [surgeForecast];
