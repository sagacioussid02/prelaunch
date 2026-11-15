/**
 * RapidAPI gateway: request authentication and per-plan safety limits for
 * the pay-per-call launch-readiness API (POST /api/v1/check).
 *
 * RapidAPI sits in front of the endpoint, sells the plans, counts calls and
 * enforces each plan's quota. On every request it forwards, the gateway adds
 * (https://docs.rapidapi.com/docs/additional-request-headers):
 *   - X-RapidAPI-Proxy-Secret  a secret unique to this API (Provider
 *                              Dashboard > Security). Missing or different
 *                              means the request did not come through RapidAPI.
 *   - X-RapidAPI-User          the consumer's RapidAPI username
 *   - X-RapidAPI-Subscription  BASIC | PRO | ULTRA | MEGA | CUSTOM
 *
 * So the only credential checked here is the proxy secret, compared in
 * constant time against RAPIDAPI_PROXY_SECRET. When that env var is unset
 * the endpoint refuses every call (fail closed): it must never be open to
 * direct, unbilled traffic.
 *
 * Limits: RapidAPI enforces the paid quota; ours are a safety net against
 * a runaway client or a leaked secret, keyed per RapidAPI user and sized by
 * plan (apiCallsPerHour). They don't replace the shared per-target-host cap
 * (lib/ratelimit.ts), which still bounds how often any one site is scanned.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export type RapidApiPlan = "BASIC" | "PRO" | "ULTRA" | "MEGA" | "CUSTOM";
const PLANS: readonly RapidApiPlan[] = ["BASIC", "PRO", "ULTRA", "MEGA", "CUSTOM"];

/**
 * Hourly safety caps per RapidAPI user, by plan. Set comfortably above the
 * suggested RapidAPI quotas (docs/rapidapi-listing.md) so a normal customer
 * never sees them; RapidAPI's own quota is the one they pay against.
 */
export const API_CALLS_PER_HOUR: Record<RapidApiPlan, number> = {
  BASIC: 20,
  PRO: 120,
  ULTRA: 400,
  MEGA: 1000,
  CUSTOM: 1000,
};

export function apiCallsPerHour(plan: RapidApiPlan): number {
  return API_CALLS_PER_HOUR[plan];
}

/**
 * Global hourly cap on API calls across all RapidAPI users, separate from
 * the website's global scan cap so API traffic can't use up website scans
 * (or the reverse). Tunable with PRELAUNCH_API_CALLS_PER_HOUR (read per call).
 */
export const DEFAULT_API_GLOBAL_CALLS_PER_HOUR = 1000;

export function apiGlobalCallsPerHour(): number {
  const n = Number(process.env.PRELAUNCH_API_CALLS_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_API_GLOBAL_CALLS_PER_HOUR;
}

/** Unknown or missing plan headers get the smallest (BASIC) limits. */
export function parsePlan(header: string | null): RapidApiPlan {
  const p = header?.trim().toUpperCase();
  return PLANS.includes(p as RapidApiPlan) ? (p as RapidApiPlan) : "BASIC";
}

export type RapidApiAuth =
  | { ok: true; user: string; plan: RapidApiPlan; limitKey: string }
  | { ok: false; status: 401 | 503; reason: string };

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time string compare (hashing first makes lengths equal). */
function secretsMatch(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

/**
 * Checks that the request came through RapidAPI. Read the env var per
 * call (not at module load) so tests and secret rotation work.
 */
export function authorizeRapidApiRequest(headers: Headers): RapidApiAuth {
  const expected = process.env.RAPIDAPI_PROXY_SECRET;
  if (!expected) {
    return { ok: false, status: 503, reason: "this API is not enabled on this deployment" };
  }
  const given = headers.get("x-rapidapi-proxy-secret");
  if (!given || !secretsMatch(given, expected)) {
    return {
      ok: false,
      status: 401,
      reason: "call this API through RapidAPI (missing or invalid gateway secret)",
    };
  }
  const user = headers.get("x-rapidapi-user")?.trim() || "unknown";
  const plan = parsePlan(headers.get("x-rapidapi-subscription"));
  // Usernames are hashed into the limiter key so they never sit in Redis raw.
  const limitKey = `api:user:${sha256(user.toLowerCase()).toString("hex").slice(0, 24)}`;
  return { ok: true, user, plan, limitKey };
}
