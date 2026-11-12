/**
 * Launch traffic forecast, milestone 1: measurement.
 *
 * Answers "what does one page view cost the host?" from the outside:
 * which CDN serves the site, whether each key route is served from cache
 * or runs a function on every visit, and how static assets are cached
 * (from the browser snapshot's per-response records).
 *
 * This is a cache inspection, NOT a load test:
 * - at most two plain GETs per route, issued one at a time (never a burst);
 * - home plus at most `maxRoutes - 1` same-origin links, skipping anything
 *   that looks state-changing (logout, unsubscribe, delete, /api/...);
 * - every hop goes through fetchWithTimeout, i.e. the SSRF guard;
 * - the scanner's documented User-Agent (privacy page / opt-out).
 *
 * The projection (usage per N visitors vs plan caps) is milestone 2 and
 * lives in lib/surge/model.ts; nothing here grades or produces findings.
 */

import type { ScanContext } from "../checks/types.ts";
import { cachedGet, fetchWithTimeout } from "../checks/types.ts";

export const SURGE_USER_AGENT =
  "PreLaunchCheck/0.1 (pre-launch security audit; +https://prelaunch-check.vercel.app/privacy)";

export type HostKind = "vercel" | "netlify" | "cloudflare" | "unknown";

/** Detects the serving platform from response headers (lower-cased keys). */
export function detectHost(h: Record<string, string>): HostKind {
  if ("x-vercel-id" in h || "x-vercel-cache" in h || (h["server"] ?? "").toLowerCase() === "vercel") return "vercel";
  if ("x-nf-request-id" in h || (h["server"] ?? "").toLowerCase() === "netlify") return "netlify";
  if ("cf-ray" in h || "cf-cache-status" in h || (h["server"] ?? "").toLowerCase() === "cloudflare") return "cloudflare";
  return "unknown";
}

export interface ProbeSample {
  status: number;
  /** Time until response headers arrived (includes redirect hops) */
  ttfbMs: number;
  /** Decoded body length in bytes */
  bodyBytes: number;
  /** Declared content-length (encoded size) when the server sent one */
  contentLength: number | null;
  contentType: string;
  cacheControl: string;
  vercelCache: string;
  cdnCache: string;
  age: number | null;
  setsCookie: boolean;
  varyCookie: boolean;
  host: HostKind;
  error?: string;
}

export type CacheVerdict = "cached" | "uncached" | "unknown";

export interface RouteProbe {
  url: string;
  first: ProbeSample;
  /** Absent when the time budget ran out before the repeat request */
  second?: ProbeSample;
  verdict: CacheVerdict;
  /** Plain-language reason for the verdict */
  reason: string;
  /** Present when the HTML carries something that defeats shared caching */
  cacheBreaker?: "set-cookie" | "vary-cookie";
}

export interface SurgeMeasurement {
  host: HostKind;
  routes: RouteProbe[];
  /** HTTP requests this measurement made (for the "not a load test" budget) */
  requests: number;
  /** Routes skipped because the time budget ran out */
  skipped: string[];
  measuredAt: string;
}

export interface MeasureOptions {
  /** Routes to probe; the first should be the home page */
  routes: string[];
  /** Max routes including home (default 6) */
  maxRoutes?: number;
  /** Minimum time between a route's first and second request (default 2000ms) */
  gapMs?: number;
  /** Per-request timeout (default 8000ms) */
  timeoutMs?: number;
  /** Stop starting new requests after this long (default 40000ms) */
  budgetMs?: number;
}

/** Paths a scanner must never GET, even though GET "should" be safe. */
const UNSAFE_PATH = /(^|\/)(api|_next|auth|logout|log-out|signout|sign-out|unsubscribe|delete|remove|cancel|checkout|webhooks?)(\/|$|\?)/i;
const ASSET_PATH = /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|gz|mp4|mp3|woff2?|css|js|map|xml|txt|json)$/i;

/** Same-origin, page-like, not state-changing; deduped by path. */
export function pickRoutes(target: string, links: string[], maxRoutes = 6): string[] {
  const origin = new URL(target).origin;
  const home = new URL(target).toString();
  const seen = new Set<string>([new URL(target).pathname.replace(/\/$/, "") || "/"]);
  const out = [home];
  for (const l of links) {
    if (out.length >= maxRoutes) break;
    let u: URL;
    try {
      u = new URL(l, target);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    const path = u.pathname.replace(/\/$/, "") || "/";
    if (seen.has(path) || UNSAFE_PATH.test(path) || ASSET_PATH.test(path)) continue;
    seen.add(path);
    u.hash = "";
    out.push(u.toString());
  }
  return out;
}

/** Same-origin <a href> links from raw HTML (used when no browser ran). */
export function linksFromHtml(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      out.push(new URL(m[1], base).toString());
    } catch {
      /* skip */
    }
  }
  return out;
}

function headerRecord(res: Response): Record<string, string> {
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    h[k.toLowerCase()] = v;
  });
  return h;
}

/** One plain GET through the SSRF-guarded fetcher. Never throws. */
export async function probeOnce(url: string, timeoutMs = 8000): Promise<ProbeSample> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, timeoutMs, {
      headers: { "User-Agent": SURGE_USER_AGENT, Accept: "text/html,*/*;q=0.8" },
    });
    const ttfbMs = Date.now() - t0;
    const h = headerRecord(res);
    const body = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    const ageNum = Number(h["age"]);
    return {
      status: res.status,
      ttfbMs,
      bodyBytes: body.byteLength,
      contentLength: h["content-length"] != null ? Number(h["content-length"]) || 0 : null,
      contentType: (h["content-type"] ?? "").split(";")[0].trim(),
      cacheControl: h["cache-control"] ?? "",
      vercelCache: (h["x-vercel-cache"] ?? "").toUpperCase(),
      cdnCache: (h["cf-cache-status"] ?? h["cache-status"] ?? h["x-cache"] ?? "").toUpperCase(),
      age: h["age"] != null && Number.isFinite(ageNum) ? ageNum : null,
      setsCookie: res.headers.has("set-cookie"),
      varyCookie: /(^|,)\s*cookie\s*(,|$)/i.test(h["vary"] ?? ""),
      host: detectHost(h),
    };
  } catch (err) {
    return {
      status: 0,
      ttfbMs: Date.now() - t0,
      bodyBytes: 0,
      contentLength: null,
      contentType: "",
      cacheControl: "",
      vercelCache: "",
      cdnCache: "",
      age: null,
      setsCookie: false,
      varyCookie: false,
      host: "unknown",
      error: String((err as Error).message ?? err).slice(0, 160),
    };
  }
}

/** Parses max-age / s-maxage (seconds) out of a Cache-Control value. */
export function directive(cacheControl: string, name: "max-age" | "s-maxage"): number | null {
  const m = cacheControl.match(new RegExp(`(?:^|[,\\s])${name}=(\\d+)`, "i"));
  return m ? Number(m[1]) : null;
}

const CACHED_VERCEL = new Set(["HIT", "PRERENDER", "STALE"]);

/**
 * Decides whether a route is served from the CDN or runs a function on
 * every visit, from two sequential requests. A MISS followed by a HIT is
 * healthy: our own first request warmed the cache.
 */
export function routeVerdict(first: ProbeSample, second?: ProbeSample): { verdict: CacheVerdict; reason: string } {
  const last = second ?? first;
  if (first.error || first.status === 0) return { verdict: "unknown", reason: `no response (${first.error ?? "network error"})` };
  if (last.status >= 400) return { verdict: "unknown", reason: `returned HTTP ${last.status}` };

  // Vercel tells us directly.
  if (last.vercelCache) {
    const a = first.vercelCache;
    const b = last.vercelCache;
    if (CACHED_VERCEL.has(b)) {
      return { verdict: "cached", reason: a === "MISS" ? "MISS then HIT: cached after the first visit" : `served from cache (${b})` };
    }
    if (b === "BYPASS" || a === "BYPASS") return { verdict: "uncached", reason: "cache bypassed (BYPASS): a function runs on every visit" };
    if (b === "MISS" && (!second || a === "MISS")) {
      return second
        ? { verdict: "uncached", reason: "MISS on both visits: a function runs on every visit" }
        : { verdict: "unknown", reason: "MISS on the first visit; no repeat visit to confirm" };
    }
    if (b === "REVALIDATED") return { verdict: "unknown", reason: "regenerated on request (REVALIDATED)" };
  }

  // Other CDNs: Cloudflare / RFC 9211 Cache-Status / X-Cache.
  if (last.cdnCache) {
    if (/HIT/.test(last.cdnCache)) return { verdict: "cached", reason: `served from cache (${last.cdnCache})` };
    if (/BYPASS|DYNAMIC/.test(last.cdnCache)) return { verdict: "uncached", reason: `not cached by the CDN (${last.cdnCache})` };
    if (second && /MISS/.test(first.cdnCache) && /MISS/.test(last.cdnCache)) {
      return { verdict: "uncached", reason: "MISS on both visits" };
    }
  }

  // Fall back to what the origin asks for.
  const cc = last.cacheControl.toLowerCase();
  if (/no-store|private/.test(cc)) return { verdict: "uncached", reason: `Cache-Control "${last.cacheControl}" forbids shared caching` };
  const shared = directive(cc, "s-maxage") ?? (/public/.test(cc) ? directive(cc, "max-age") : null);
  if (shared && shared > 0) {
    const aged = second && second.age != null && second.age > 0;
    return { verdict: "cached", reason: aged ? "shared cache with a growing Age header" : `Cache-Control allows shared caching for ${shared}s` };
  }
  return { verdict: "unknown", reason: "no CDN cache signal in the response headers" };
}

export type AssetPolicy = "long" | "short" | "revalidates" | "none";

/**
 * How a static asset is cached in the browser. "revalidates" assets cost a
 * CDN request on every repeat page view, even when the answer is a 304.
 */
export function assetCachePolicy(cacheControl: string): AssetPolicy {
  const cc = cacheControl.toLowerCase();
  if (!cc) return "none";
  if (/immutable/.test(cc)) return "long";
  if (/no-store|no-cache/.test(cc)) return "revalidates";
  const maxAge = directive(cc, "max-age");
  if (maxAge == null) return "none";
  if (maxAge === 0) return "revalidates";
  return maxAge >= 86400 ? "long" : "short";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Probes each route twice, one request at a time: all first visits, then
 * the repeat visits, each no sooner than `gapMs` after its first. Total
 * requests <= 2 x routes.
 */
export async function measureSurge(opts: MeasureOptions): Promise<SurgeMeasurement> {
  const maxRoutes = opts.maxRoutes ?? 6;
  const gapMs = opts.gapMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const budgetMs = opts.budgetMs ?? 40000;
  const routes = opts.routes.slice(0, maxRoutes);
  const started = Date.now();
  const overBudget = () => Date.now() - started > budgetMs;
  let requests = 0;
  const skipped: string[] = [];

  const firsts: Array<{ url: string; at: number; sample: ProbeSample }> = [];
  for (const url of routes) {
    if (overBudget()) {
      skipped.push(url);
      continue;
    }
    const at = Date.now();
    firsts.push({ url, at, sample: await probeOnce(url, timeoutMs) });
    requests++;
  }

  const probes: RouteProbe[] = [];
  for (const f of firsts) {
    let second: ProbeSample | undefined;
    if (!f.sample.error && f.sample.status > 0 && !overBudget()) {
      const wait = f.at + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      second = await probeOnce(f.url, timeoutMs);
      requests++;
    }
    const { verdict, reason } = routeVerdict(f.sample, second);
    const last = second ?? f.sample;
    const cacheBreaker = last.setsCookie ? "set-cookie" : last.varyCookie ? "vary-cookie" : undefined;
    probes.push({ url: f.url, first: f.sample, ...(second ? { second } : {}), verdict, reason, ...(cacheBreaker ? { cacheBreaker } : {}) });
  }

  const host = probes.find((p) => p.first.host !== "unknown")?.first.host ?? "unknown";
  return { host, routes: probes, requests, skipped, measuredAt: new Date().toISOString() };
}

/**
 * Per-scan memo: the measurement runs once even if several checks ask for
 * it. Routes come from the desktop browser snapshot's links when a
 * browser is available, otherwise from the home page HTML.
 */
export function getSurgeMeasurement(
  ctx: ScanContext,
  linksFromBrowser?: () => Promise<string[] | null>,
): Promise<SurgeMeasurement> {
  if (!ctx.surge) {
    ctx.surge = (async () => {
      let links = linksFromBrowser ? await linksFromBrowser().catch(() => null) : null;
      if (!links) links = linksFromHtml((await cachedGet(ctx, ctx.target)).body, ctx.target);
      return measureSurge({ routes: pickRoutes(ctx.target, links) });
    })();
  }
  return ctx.surge as Promise<SurgeMeasurement>;
}
