/**
 * Shared per-key rate limiter (Phase 0 step 2 of the path-to-release plan;
 * part of issue #6 — shared-store limits).
 *
 * Ported from the prototype stack (launch prep part 2, 2026-10-29), where
 * it backed /api/scan (5/hr/IP) and /api/waitlist (10/hr/IP). Here it backs
 * POST /api/scan and POST /api/monitor (creation) since step 2, and
 * POST /api/waitlist since step 3. Phase 1 adds the per-target-host and
 * global scan limits (checkScanTargetLimits).
 *
 * Production (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set):
 * fixed-window counters in Upstash Redis via its HTTP REST API — no SDK
 * dependency, and the counter is shared across Vercel instances, unlike
 * the old per-process maps. First hit in a window also sets the key's TTL,
 * so windows are fixed, not sliding.
 *
 * Local / private preview (env vars unset): in-memory sliding window with
 * the same interface. No infra to configure, so local dev and
 * scripts/test-scan.ts keep working unchanged.
 *
 * Failure mode: if the Redis call fails, the request is REJECTED
 * (fail-closed). A misconfigured Redis must not silently turn into
 * unlimited free scans; the error is logged so the deploy owner sees it.
 * In-memory mode never fails this way.
 */

export interface LimitResult {
  allowed: boolean;
  /** Seconds until the window resets; present when not allowed. */
  retryAfterSeconds?: number;
}

/** Per-IP hourly limits, shared by the API routes. */
export const SCANS_PER_HOUR_PER_IP = 5;
export const MONITORS_PER_HOUR_PER_IP = 10;
/** Used by /api/waitlist (step 3); defined here so the route only wires it. */
export const WAITLIST_SIGNUPS_PER_HOUR_PER_IP = 10;
export const RATE_WINDOW_SECONDS = 3600;

/**
 * Scan limits beyond per-IP (Phase 1, issue #6): a target host may be
 * scanned at most SCANS_PER_HOUR_PER_HOST times per hour across ALL
 * callers, so many IPs can't be pointed at one third-party site; and a
 * global hourly cap bounds total outbound scanning. The global cap can be
 * tuned with PRELAUNCH_GLOBAL_SCANS_PER_HOUR (read per call).
 */
export const SCANS_PER_HOUR_PER_HOST = 10;
export const DEFAULT_GLOBAL_SCANS_PER_HOUR = 200;

export function globalScansPerHour(): number {
  const n = Number(process.env.PRELAUNCH_GLOBAL_SCANS_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_GLOBAL_SCANS_PER_HOUR;
}

/** Rate-limit key for a target host: lowercased, leading "www." dropped. */
export function scanHostKey(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

export type ScanLimitScope = "host" | "global";

/**
 * Per-host, then global scan limits for an accepted, parsed request. The
 * per-IP limit is checked separately, before the body is read. Order
 * matters: a host-limited request does not consume global quota.
 */
export async function checkScanTargetLimits(
  hostname: string,
): Promise<LimitResult & { scope?: ScanLimitScope }> {
  const host = await checkLimit(
    `scanhost:${scanHostKey(hostname)}`,
    SCANS_PER_HOUR_PER_HOST,
    RATE_WINDOW_SECONDS,
  );
  if (!host.allowed) return { ...host, scope: "host" };
  const global = await checkLimit("scanglobal", globalScansPerHour(), RATE_WINDOW_SECONDS);
  if (!global.allowed) return { ...global, scope: "global" };
  return { allowed: true };
}

const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisConfigured(): boolean {
  return !!redisUrl && !!redisToken;
}

async function redisIncr(key: string, windowSeconds: number): Promise<number> {
  const headers = { Authorization: `Bearer ${redisToken}` };
  const incrRes = await fetch(
    `${redisUrl}/incr/${encodeURIComponent(key)}`,
    { method: "POST", headers },
  );
  if (!incrRes.ok) throw new Error(`upstash incr failed: ${incrRes.status}`);
  const incrBody = (await incrRes.json()) as { result?: number };
  const count = incrBody.result;
  if (typeof count !== "number") throw new Error("upstash incr: bad response");
  if (count === 1) {
    // First hit in this window: arm the TTL. Fixed window, not sliding.
    await fetch(
      `${redisUrl}/expire/${encodeURIComponent(key)}/${windowSeconds}`,
      { method: "POST", headers },
    );
  }
  return count;
}

// ---- In-memory fallback (local dev / private preview) ----

const hits = new Map<string, number[]>(); // key -> request timestamps (ms)

function memoryCheck(key: string, limit: number, windowMs: number): LimitResult {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    const oldest = recent[0] ?? now;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }
  recent.push(now);
  hits.set(key, recent);
  return { allowed: true };
}

/**
 * Check one key against `limit` requests per `windowSeconds`. Callers pass
 * a namespaced key, e.g. `scan:1.2.3.4` or `monitor:1.2.3.4`.
 */
export async function checkLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<LimitResult> {
  if (redisConfigured()) {
    try {
      const count = await redisIncr(key, windowSeconds);
      if (count > limit) {
        return { allowed: false, retryAfterSeconds: windowSeconds };
      }
      return { allowed: true };
    } catch (err) {
      console.error("ratelimit: redis error, failing closed", err);
      return { allowed: false, retryAfterSeconds: windowSeconds };
    }
  }
  return memoryCheck(key, limit, windowSeconds * 1000);
}

/** Client IP for rate-limit keys: x-forwarded-for first hop, else x-real-ip. */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
}
