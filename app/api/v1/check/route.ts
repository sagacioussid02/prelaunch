import { NextRequest, NextResponse } from "next/server";
import { apiCallsPerHour, apiGlobalCallsPerHour, authorizeRapidApiRequest } from "@/lib/rapidapi";
import { prepareTarget, QuickCheckInputError, runQuickCheck } from "@/lib/quickcheck";
import {
  checkLimit,
  clientIp,
  RATE_WINDOW_SECONDS,
  scanHostKey,
  SCANS_PER_HOUR_PER_HOST,
} from "@/lib/ratelimit";
import { logScanRequest } from "@/lib/scanlog";

/**
 * POST /api/v1/check { url } — the pay-per-call launch-readiness API,
 * sold through RapidAPI. Runs three passive checks (lib/quickcheck.ts) and
 * answers inline with a grade, a ready flag and the findings, usually in a
 * few seconds. Nothing is stored.
 *
 * Auth (lib/rapidapi.ts): the X-RapidAPI-Proxy-Secret header must match
 * RAPIDAPI_PROXY_SECRET. Unset env → 503 for every call (fail closed).
 *
 * Limits, in order:
 * 1. Gateway secret checked first; failures never read the body.
 * 2. Per RapidAPI user, sized by plan (X-RapidAPI-Subscription). RapidAPI
 *    enforces the paid quota; this is the safety net.
 * 3. The shared per-target-host cap (SCANS_PER_HOUR_PER_HOST, same counter
 *    as /api/scan), so the API can't aim more traffic at one site than the
 *    website allows.
 * 4. Global API cap (PRELAUNCH_API_CALLS_PER_HOUR, default 1000/hour),
 *    separate from the website's. A host-limited call uses no global quota.
 * 5. Per-instance concurrency cap.
 * Every fetch goes through the SSRF guard.
 *
 * Every response is JSON; errors are { error, status }.
 */
const MAX_CONCURRENT_API_CHECKS = 8;
let inFlight = 0;

function fail(status: number, error: string, retryAfter?: number): NextResponse {
  return NextResponse.json(
    { error, status },
    { status, headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined },
  );
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);

  const auth = authorizeRapidApiRequest(req.headers);
  if (!auth.ok) {
    await logScanRequest({ ip, mode: "api", outcome: "unauthorized" });
    return fail(auth.status, auth.reason);
  }
  const mode = `api-${auth.plan.toLowerCase()}`;

  const perHour = apiCallsPerHour(auth.plan);
  const userLimit = await checkLimit(auth.limitKey, perHour, RATE_WINDOW_SECONDS);
  if (!userLimit.allowed) {
    await logScanRequest({ ip, mode, outcome: "rate_limited_api" });
    return fail(429, `rate limit exceeded: ${perHour} checks/hour on the ${auth.plan} plan`, userLimit.retryAfterSeconds ?? 3600);
  }

  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  let target: { url: string; host: string };
  try {
    target = await prepareTarget(body?.url);
  } catch (err) {
    await logScanRequest({ ip, mode, outcome: "invalid" });
    if (err instanceof QuickCheckInputError) return fail(err.status, err.message);
    throw err;
  }

  const host = await checkLimit(`scanhost:${scanHostKey(target.host)}`, SCANS_PER_HOUR_PER_HOST, RATE_WINDOW_SECONDS);
  if (!host.allowed) {
    await logScanRequest({ ip, host: target.host, mode, outcome: "rate_limited_host" });
    return fail(
      429,
      `rate limit exceeded: this site was checked ${SCANS_PER_HOUR_PER_HOST} times in the last hour; try again later`,
      host.retryAfterSeconds ?? 3600,
    );
  }

  const global = await checkLimit("apiglobal", apiGlobalCallsPerHour(), RATE_WINDOW_SECONDS);
  if (!global.allowed) {
    await logScanRequest({ ip, host: target.host, mode, outcome: "rate_limited_global" });
    return fail(429, "the API is at its hourly capacity; try again later", global.retryAfterSeconds ?? 3600);
  }

  if (inFlight >= MAX_CONCURRENT_API_CHECKS) {
    await logScanRequest({ ip, host: target.host, mode, outcome: "busy" });
    return fail(429, "server busy: too many checks in progress", 10);
  }

  inFlight++;
  try {
    const result = await runQuickCheck(target.url);
    await logScanRequest({ ip, host: target.host, mode, outcome: "accepted" });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof QuickCheckInputError) {
      await logScanRequest({ ip, host: target.host, mode, outcome: "unreachable" });
      return fail(err.status, err.message);
    }
    console.error("api check: unexpected error", err);
    await logScanRequest({ ip, host: target.host, mode, outcome: "error" });
    return fail(500, "the check could not be completed; try again");
  } finally {
    inFlight--;
  }
}

/** Three checks with a 15s per-check timeout; well inside RapidAPI's 180s gateway limit. */
export const maxDuration = 60;
