/**
 * PreLaunch Check — shared types for the scan engine.
 *
 * Every check implements the Check interface: an async function taking a
 * ScanContext and returning a list of Findings. Checks are registered in
 * lib/checks/index.ts so new ones plug in without touching the runner.
 *
 * Scan modes (per the revised scan-toggle stance, 2026-10-16):
 * - "passive": anonymous paste-any-URL scans. Read-only, single GETs to
 *   public resources only — no active probing of third-party sites.
 * - "full":   site-owner scans behind ownership proof (deploy-hook
 *   integration, v2). Enables the signature checks like bundle secret
 *   scanning and RLS smoke tests.
 */

export type Severity = "blocker" | "warning" | "info";
export type ScanMode = "passive" | "full";

export interface ScanContext {
  /** Normalized target origin, e.g. "https://app.example.com" */
  target: string;
  /** "passive" for anonymous scans, "full" behind ownership proof */
  mode: ScanMode;
  /** Shared per-scan state (fetched pages, headers) to avoid duplicate GETs */
  cache: Map<string, CachedResponse>;
  /** Scan id, used to name saved artifacts such as screenshots */
  scanId: string;
  /** Screenshots captured by browser simulations */
  screenshots: Screenshot[];
  /** Lazily-created shared headless-browser session (see lib/checks/browser.ts) */
  session?: unknown;
}

export interface Screenshot {
  /** URL-safe slug, e.g. "desktop" */
  name: string;
  label: string;
  width: number;
  height: number;
}

export interface CheckProgress {
  id: string;
  name: string;
  category: string;
  /** What this check looks for, in plain language */
  description: string;
  status: "pending" | "running" | "done";
  findingCount?: number;
  worst?: Severity;
  ms?: number;
}

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
}

export interface Finding {
  checkId: string;
  severity: Severity;
  /** Human-readable title, e.g. "Missing Content-Security-Policy" */
  title: string;
  /** Where it was found — URL, header name, chunk path */
  location: string;
  /** One-line fix guidance */
  fix: string;
  /** Docs link for the fix (optional) */
  fixLink?: string;
}

export interface Check {
  id: string;
  /** Display name for the report */
  name: string;
  /** Category, e.g. "Secrets exposure" */
  category: string;
  /** Grading weight of the category (see lib/scanner.ts) */
  categoryWeight: number;
  /** Whether the check may run in passive (anonymous) mode */
  modes: ScanMode[];
  /** Override the runner's default per-check timeout (browser simulations are slower) */
  timeoutMs?: number;
  run(ctx: ScanContext): Promise<Finding[]>;
}

export interface ScanResult {
  id: string;
  url: string;
  mode: ScanMode;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  score: number;
  grade: string;
  findings: Finding[];
  /** Per-check timing for the report metadata */
  checkTimings: Record<string, number>;
  /** Live per-check progress; final state doubles as the "what we checked" list */
  progress?: CheckProgress[];
  screenshots?: Screenshot[];
  /** Set when status is "failed" */
  error?: string;
}

import { assertSafeHostname, MAX_REDIRECT_HOPS } from "../ssrf.ts";

/** Fetch with a hard per-request timeout.
 *
 * Redirects are followed manually (never `redirect: "follow"`) so the SSRF
 * guard re-validates every hop: a redirect from a public host to an
 * internal/metadata address is rejected instead of followed.
 */
/**
 * True for undici's network-failure TypeError ("fetch failed"), the signature
 * of a dead keep-alive socket / reset connection. Timeouts (AbortError) and
 * SSRF-guard throws are NOT retried here.
 */
function isTransientNetworkError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /fetch failed/i.test((err as Error).message ?? "")
  );
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const parsed = new URL(current);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`SSRF guard: unsupported protocol (${parsed.protocol})`);
    }
    await assertSafeHostname(parsed.hostname);

    let res: Response | undefined;
    // Retry once on transient network failure: a request can race onto a
    // keep-alive socket the server/proxy just closed ("other side closed").
    // The retry opens a fresh connection. Safe — scanner only issues GETs.
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        res = await fetch(current, {
          ...init,
          signal: ctrl.signal,
          redirect: "manual",
        });
        break;
      } catch (err) {
        if (attempt === 0 && isTransientNetworkError(err)) continue;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!res) throw new Error("fetch retry exhausted without a result"); // unreachable

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // Drain before hopping so sockets aren't leaked.
      await res.arrayBuffer().catch(() => {});
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("SSRF guard: too many redirects");
}

/** Fetch once per scan and cache the result (status, headers, text body). */
export async function cachedGet(
  ctx: ScanContext,
  url: string,
  timeoutMs = 8000,
): Promise<CachedResponse> {
  const hit = ctx.cache.get(url);
  if (hit) return hit;
  try {
    const res = await fetchWithTimeout(url, timeoutMs, {
      headers: { "User-Agent": "PreLaunchCheck/0.1 (pre-launch security audit)" },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body = await res.text().catch(() => "");
    const cached: CachedResponse = { status: res.status, headers, body, url: res.url };
    ctx.cache.set(url, cached);
    return cached;
  } catch (err) {
    const cached: CachedResponse = {
      status: 0,
      headers: {},
      body: "",
      url,
    };
    ctx.cache.set(url, cached);
    return cached;
  }
}

/** Extract <script src="..."> URLs from HTML, resolved against base. */
export function extractScriptSrcs(html: string, base: string): string[] {
  const out = new Set<string>();
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.add(new URL(m[1], base).toString());
    } catch {
      /* skip unparseable */
    }
  }
  return [...out];
}

/** Extract <meta> tags as {name|property: content}. */
export function extractMetas(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<meta[^>]+>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const name =
      tag.match(/(?:name|property)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
    if (name && content !== undefined) out[name] = content;
  }
  return out;
}

/** Shannon entropy — used to separate real keys from lookalikes. */
export function entropy(s: string): number {
  if (!s.length) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
