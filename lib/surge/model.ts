/**
 * Launch traffic forecast, milestone 2: the projection.
 *
 * Pure functions, no network. Two steps:
 *
 * 1. `forecastInputs()` turns what milestone 1 measured (route cache
 *    verdicts from lib/surge/measure.ts, plus the browser snapshot's
 *    per-response records) into the cost of ONE visitor's first page view
 *    and of each further page view.
 * 2. `project()` scales that to V visitors viewing P pages each and sets it
 *    against a plan's monthly amounts (lib/surge/pricing.ts):
 *
 *      usage_r = V * (first_r + (P - 1) * repeat_r)
 *      V_cap   = min_r cap_r / (first_r + (P - 1) * repeat_r)
 *
 * The stored inputs are small, so the report can re-run `project()` in the
 * browser for any visitor count or plan (milestone 3).
 *
 * It is an estimate from a sample of pages, not a quote: it can't see
 * middleware, server-side data fetching or the site's real traffic mix.
 * Assumptions are returned with every forecast so the report can show them.
 */

import type { ResponseRecord } from "../checks/browser.ts";
import type { HostKind, RouteProbe, SurgeMeasurement } from "./measure.ts";
import { assetCachePolicy } from "./measure.ts";
import type { PlanPricing, Resource } from "./pricing.ts";
import { RESOURCES, RESOURCE_ORDER } from "./pricing.ts";

/** Launch size the grade is computed at, so scans and monitor diffs stay comparable. */
export const DEFAULT_VISITORS = 10_000;
export const DEFAULT_PAGES_PER_VISITOR = 2;
/**
 * Active CPU per function invocation. Not observable from outside the site
 * (response time includes waiting on the network and databases, which
 * Active CPU does not bill), so this is a stated assumption.
 */
export const DEFAULT_CPU_MS_PER_INVOCATION = 50;

/** What one page view costs the host. Bytes are encoded (on-the-wire) sizes. */
export interface ViewCost {
  /** Requests served by the site's own CDN (same-origin responses) */
  cdnRequests: number;
  /** Bytes sent from the CDN to the visitor */
  transferBytes: number;
  /** Responses produced by a function rather than the cache */
  invocations: number;
  /** Bytes the functions sent to the CDN (uncached responses) */
  originBytes: number;
}

export interface RouteSummary {
  path: string;
  verdict: RouteProbe["verdict"];
  reason: string;
  cacheBreaker?: RouteProbe["cacheBreaker"];
  /** Time to first byte on the first and the repeat request */
  ttfbMs: number;
  repeatTtfbMs?: number;
}

export interface ForecastInputs {
  host: HostKind;
  /** The landing page view: every same-origin asset is downloaded */
  firstView: ViewCost;
  /** Each further page view: long-cached assets come from the browser cache */
  repeatView: ViewCost;
  /**
   * Distinct optimized-image URLs seen. Image transformations are billed
   * once per distinct image and then cached, so this does not grow with
   * visitors.
   */
  imageTransforms: number;
  cpuMsPerInvocation: number;
  routes: RouteSummary[];
  /** Same-origin static assets that revalidate on every view (paths, first 10) */
  revalidatingAssets: string[];
  revalidatingAssetCount: number;
  /** Set when part of the measurement is missing, in plain language */
  partial?: string;
  /** Plain-language assumptions, shown next to the forecast */
  assumptions: string[];
}

export interface ResourceForecast {
  resource: Resource;
  label: string;
  /** Usage in the plan's unit (requests, GB, hours, ...) */
  usage: number;
  /** Monthly amount included in the plan; null when the plan sets none */
  included: number | null;
  /** usage / included; null when there is nothing to compare against */
  share: number | null;
  /** Visitors (at the same pages per visitor) before `included` is used up; null = never in this model */
  capacityVisitors: number | null;
  /** On-demand cost beyond the included amount, USD; null when the plan sells none */
  overageUsd: number | null;
}

export interface Projection {
  plan: PlanPricing["id"];
  visitors: number;
  pagesPerVisitor: number;
  rows: ResourceForecast[];
  /** Visitors before the first included amount runs out; null = none runs out */
  capacityVisitors: number | null;
  /** Resource that runs out first */
  firstLimit: Resource | null;
  /** Base price plus on-demand charges beyond included amounts and the usage credit, USD (a floor: "starting at" rates) */
  estimatedMonthlyUsd: number;
}

const CACHED_MARKERS = new Set(["HIT", "STALE", "PRERENDER"]);

function isOptimizedImage(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return p.startsWith("/_next/image") || p.startsWith("/_vercel/image");
  } catch {
    return false;
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

const STATIC_TYPES = new Set(["script", "stylesheet", "image", "font", "media"]);
const DYNAMIC_TYPES = new Set(["fetch", "xhr", "eventsource", "websocket"]);

/** True when a same-origin request was answered by a function, judged by the CDN's own header. */
function servedByFunction(r: ResponseRecord): boolean {
  // Still open when the snapshot ended: counted as a request, cost unknown.
  if (r.status === 0) return false;
  if (r.status >= 300 && r.status < 400) return false;
  const v = r.vercelCache;
  if (v) return !CACHED_MARKERS.has(v);
  const c = r.cdnCache.toUpperCase();
  if (c) return !/HIT|STALE|UPDATING|REVALIDATED/.test(c);
  // No CDN signal: a private/no-store API answer is assumed dynamic, anything else cached.
  return /private|no-store/i.test(r.cacheControl);
}

/** Share of probed routes that run a function on every visit (unknown counts as cached). */
function uncachedShare(routes: RouteProbe[]): number {
  const known = routes.filter((r) => r.verdict !== "unknown");
  if (!known.length) return 0;
  return known.filter((r) => r.verdict === "uncached").length / known.length;
}

/** Same-origin assets referenced by raw HTML, for the no-browser fallback. */
function assetsInHtml(html: string, base: string): number {
  const origin = new URL(base).origin;
  const seen = new Set<string>();
  const re = /<(?:script[^>]+src|link[^>]+href|img[^>]+src)=["']([^"']+)["']/gi;
  for (const m of html.matchAll(re)) {
    try {
      const u = new URL(m[1], base);
      if (u.origin === origin) seen.add(u.toString());
    } catch {
      /* skip */
    }
  }
  return seen.size;
}

export interface InputSources {
  target: string;
  measurement: SurgeMeasurement;
  /** Desktop browser snapshot's response records; null when no browser ran */
  responses: ResponseRecord[] | null;
  /** Why there are no response records, when `responses` is null */
  noBrowserReason?: string;
  /** Home page HTML, used to count assets when there is no browser */
  homeHtml?: string;
  cpuMsPerInvocation?: number;
}

/** Builds the per-view costs from milestone 1's measurements. Pure. */
export function forecastInputs(src: InputSources): ForecastInputs {
  const { measurement } = src;
  const routes = measurement.routes;
  const home = routes[0];
  const others = routes.slice(1);
  const homeUncached = home ? (home.verdict === "uncached" ? 1 : 0) : 0;
  const otherShare = others.length ? uncachedShare(others) : homeUncached;
  const sampleBytes = (p: RouteProbe | undefined) => {
    const s = p?.second ?? p?.first;
    return s ? s.contentLength ?? s.bodyBytes : 0;
  };
  const homeDocBytes = sampleBytes(home);
  const otherDocBytes = others.length
    ? others.reduce((n, p) => n + sampleBytes(p), 0) / others.length
    : homeDocBytes;

  const assumptions = [
    "Each visitor lands on the home page; each further page they view costs what the other sampled pages cost.",
    "Assets cached for a day or more are not downloaded again on later pages; assets that revalidate cost one request per page.",
    `Each function run uses about ${src.cpuMsPerInvocation ?? DEFAULT_CPU_MS_PER_INVOCATION} ms of Active CPU (not measurable from outside).`,
    "Image transformations are counted once per distinct image seen on the sampled page, not per visitor.",
    "ISR reads and writes, middleware, and requests made by bots are not modelled.",
  ];

  const routeSummaries: RouteSummary[] = routes.map((r) => ({
    path: pathOf(r.url),
    verdict: r.verdict,
    reason: r.reason,
    ...(r.cacheBreaker ? { cacheBreaker: r.cacheBreaker } : {}),
    ttfbMs: r.first.ttfbMs,
    ...(r.second ? { repeatTtfbMs: r.second.ttfbMs } : {}),
  }));

  if (!src.responses) {
    // No browser: the document is all we can weigh. Asset bytes are unknown,
    // so transfer is understated; the forecast says so.
    const assets = src.homeHtml ? assetsInHtml(src.homeHtml, src.target) : 0;
    return {
      host: measurement.host,
      firstView: { cdnRequests: 1 + assets, transferBytes: homeDocBytes, invocations: homeUncached, originBytes: homeUncached * homeDocBytes },
      repeatView: { cdnRequests: 1, transferBytes: otherDocBytes, invocations: otherShare, originBytes: otherShare * otherDocBytes },
      imageTransforms: 0,
      cpuMsPerInvocation: src.cpuMsPerInvocation ?? DEFAULT_CPU_MS_PER_INVOCATION,
      routes: routeSummaries,
      revalidatingAssets: [],
      revalidatingAssetCount: 0,
      partial:
        `The browser didn't run${src.noBrowserReason ? ` (${src.noBrowserReason})` : ""}, so page weight and ` +
        "API calls were not measured; transfer and request numbers count the HTML page and its asset tags only.",
      assumptions,
    };
  }

  const own = src.responses.filter((r) => r.sameOrigin);
  const doc = own.find((r) => r.resourceType === "document");
  const docBytes = doc?.bytes ?? homeDocBytes;
  const nonDoc = own.filter((r) => r !== doc);

  const firstView: ViewCost = { cdnRequests: 0, transferBytes: 0, invocations: homeUncached, originBytes: homeUncached * docBytes };
  firstView.cdnRequests = own.length || 1;
  firstView.transferBytes = own.reduce((n, r) => n + r.bytes, 0) || docBytes;

  // Later pages: the document again, every API call again, and every static
  // asset whose cache policy makes the browser ask the CDN again.
  const repeatView: ViewCost = { cdnRequests: 1, transferBytes: otherDocBytes || docBytes, invocations: otherShare, originBytes: otherShare * (otherDocBytes || docBytes) };
  const revalidating: string[] = [];
  const images = new Set<string>();
  for (const r of nonDoc) {
    if (isOptimizedImage(r.url)) images.add(r.url);
    if (DYNAMIC_TYPES.has(r.resourceType)) {
      repeatView.cdnRequests++;
      repeatView.transferBytes += r.bytes;
      if (servedByFunction(r)) {
        firstView.invocations++;
        firstView.originBytes += r.bytes;
        repeatView.invocations++;
        repeatView.originBytes += r.bytes;
      }
      continue;
    }
    if (STATIC_TYPES.has(r.resourceType) && r.status >= 200 && r.status < 300) {
      const policy = assetCachePolicy(r.cacheControl);
      if (policy === "revalidates") {
        repeatView.cdnRequests++;
        revalidating.push(pathOf(r.url));
      } else if (policy === "none") {
        // Browsers may cache heuristically; count a request but no body.
        repeatView.cdnRequests++;
      }
    }
  }

  return {
    host: measurement.host,
    firstView,
    repeatView,
    imageTransforms: images.size,
    cpuMsPerInvocation: src.cpuMsPerInvocation ?? DEFAULT_CPU_MS_PER_INVOCATION,
    routes: routeSummaries,
    revalidatingAssets: revalidating.slice(0, 10),
    revalidatingAssetCount: revalidating.length,
    assumptions,
  };
}

const GB = 1e9;

/** Usage of every metered resource for V visitors x P pages, in the plan's units. Pure. */
export function usageFor(inputs: ForecastInputs, visitors: number, pagesPerVisitor: number): Record<Resource, number> {
  const later = Math.max(0, pagesPerVisitor - 1);
  const per = (k: keyof ViewCost) => inputs.firstView[k] + later * inputs.repeatView[k];
  const invocations = visitors * per("invocations");
  return {
    cdnRequests: visitors * per("cdnRequests"),
    fastDataTransfer: (visitors * per("transferBytes")) / GB,
    functionInvocations: invocations,
    activeCpu: (invocations * inputs.cpuMsPerInvocation) / 3_600_000,
    imageTransformations: inputs.imageTransforms,
    fastOriginTransfer: (visitors * per("originBytes")) / GB,
  };
}

/** Projects the inputs onto one plan at one launch size. Pure. */
export function project(
  inputs: ForecastInputs,
  plan: PlanPricing,
  visitors = DEFAULT_VISITORS,
  pagesPerVisitor = DEFAULT_PAGES_PER_VISITOR,
): Projection {
  const usage = usageFor(inputs, visitors, pagesPerVisitor);
  const perVisitor = usageFor(inputs, 1, pagesPerVisitor);
  let metered = 0;
  const rows: ResourceForecast[] = RESOURCE_ORDER.map((resource) => {
    const terms = plan.resources[resource];
    const included = terms?.included ?? null;
    const u = usage[resource];
    const scales = RESOURCES[resource].scalesWithVisitors;
    let capacityVisitors: number | null = null;
    if (included != null) {
      if (!scales) capacityVisitors = u > included ? 0 : null;
      else if (perVisitor[resource] > 0) capacityVisitors = Math.floor(included / perVisitor[resource]);
    }
    let overageUsd: number | null = null;
    if (terms?.rate) {
      const over = Math.max(0, u - (included ?? 0));
      overageUsd = (over / terms.rate.per) * terms.rate.usd;
      metered += overageUsd;
    }
    return {
      resource,
      label: RESOURCES[resource].label,
      usage: u,
      included,
      share: included ? u / included : null,
      capacityVisitors,
      overageUsd,
    };
  });
  let capacityVisitors: number | null = null;
  let firstLimit: Resource | null = null;
  for (const r of rows) {
    if (r.capacityVisitors == null) continue;
    if (capacityVisitors == null || r.capacityVisitors < capacityVisitors) {
      capacityVisitors = r.capacityVisitors;
      firstLimit = r.resource;
    }
  }
  // On-demand charges come out of the plan's usage credit first.
  const total = plan.monthlyBaseUsd + Math.max(0, metered - plan.usageCreditUsd);
  return { plan: plan.id, visitors, pagesPerVisitor, rows, capacityVisitors, firstLimit, estimatedMonthlyUsd: Math.round(total * 100) / 100 };
}

/** Stored on the scan result: enough to redraw and recompute the forecast. */
export interface SurgeForecast {
  inputs: ForecastInputs;
  /** The graded projection: DEFAULT_VISITORS on Hobby */
  graded: Projection;
  /** The same launch on Pro, for the cost line */
  pro: Projection;
  pricingAsOf: string;
  measuredAt: string;
  /** GETs the measurement made against the site */
  requests: number;
}

/** "about 12,300" style rounding for findings. */
export function roughly(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toLocaleString("en-US")} million`;
  if (n >= 10_000) return (Math.round(n / 1000) * 1000).toLocaleString("en-US");
  if (n >= 1000) return (Math.round(n / 100) * 100).toLocaleString("en-US");
  return Math.round(n).toLocaleString("en-US");
}
