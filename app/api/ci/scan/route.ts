import { NextRequest, NextResponse } from "next/server";
import { keepAlive } from "@/lib/background";
import { authorizeCiRequest, ciScansPerHour } from "@/lib/ciauth";
import { startScanJob } from "@/lib/jobs";
import {
  checkLimit,
  checkScanTargetLimits,
  clientIp,
  RATE_WINDOW_SECONDS,
  SCANS_PER_HOUR_PER_HOST,
} from "@/lib/ratelimit";
import { logScanRequest } from "@/lib/scanlog";
import { normalizeUrl } from "@/lib/scanner";
import { newScanId } from "@/lib/store";

/**
 * POST /api/ci/scan { url } — a scan started by the Prelaunch GitHub Action
 * (action/). Returns { id, tier, statusUrl, reportUrl, resultUrl }; the
 * Action then polls GET /api/scan/{id} and reads the result from
 * GET /api/report/{id}?format=json, the same endpoints the website uses.
 *
 * Auth (lib/ciauth.ts): `Authorization: Bearer <Prelaunch key>` for the paid
 * tier (any repository, Pro required), or a GitHub Actions OIDC token for
 * the free tier (public repositories only). Private repos without a key get
 * 402.
 *
 * Limits, in order:
 * 1. Credential checked first; failures are logged and never read the body.
 * 2. Per-credential hourly limit (free: per repository; paid: per key).
 *    This replaces the website's per-IP limit for CI because hosted
 *    runners share IPs between unrelated customers.
 * 3. The same per-target-host and global caps as /api/scan
 *    (checkScanTargetLimits), unchanged, so CI can't be used to aim more
 *    traffic at a third-party site than the website allows.
 * 4. Per-instance concurrency cap, like /api/scan.
 * Every fetch still goes through the SSRF guard (lib/ssrf.ts) inside the
 * scanner. CI scans are passive (read-only) on both tiers; full mode
 * still needs ownership proof and is not offered here.
 */
const MAX_CONCURRENT_CI_SCANS = 2;
let inFlight = 0;

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);

  let auth;
  try {
    auth = await authorizeCiRequest(req.headers.get("authorization"));
  } catch (err) {
    console.error("ci scan: auth store error", err);
    return new NextResponse("key check is temporarily unavailable; try again shortly", {
      status: 503,
      headers: { "Retry-After": "30" },
    });
  }
  if (!auth.ok) {
    await logScanRequest({
      ip,
      mode: "ci",
      outcome: auth.status === 402 ? "payment_required" : "unauthorized",
    });
    return new NextResponse(auth.reason, { status: auth.status });
  }

  const perHour = ciScansPerHour(auth.tier);
  const limit = await checkLimit(auth.limitKey, perHour, RATE_WINDOW_SECONDS);
  if (!limit.allowed) {
    await logScanRequest({ ip, mode: `ci-${auth.tier}`, outcome: "rate_limited_ci" });
    return new NextResponse(
      auth.tier === "paid"
        ? `rate limit exceeded: ${perHour} CI scans/hour per Prelaunch key`
        : `rate limit exceeded: ${perHour} CI scans/hour per repository on the free tier`,
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 3600) } },
    );
  }

  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  if (!body || typeof body.url !== "string" || !body.url) {
    await logScanRequest({ ip, mode: `ci-${auth.tier}`, outcome: "invalid" });
    return new NextResponse("missing url", { status: 400 });
  }
  let url: string;
  let host: string;
  try {
    url = normalizeUrl(body.url);
    host = new URL(url).hostname;
  } catch {
    await logScanRequest({ ip, mode: `ci-${auth.tier}`, outcome: "invalid" });
    return new NextResponse("invalid url", { status: 400 });
  }

  const target = await checkScanTargetLimits(host);
  if (!target.allowed) {
    await logScanRequest({
      ip,
      host,
      mode: `ci-${auth.tier}`,
      outcome: target.scope === "host" ? "rate_limited_host" : "rate_limited_global",
    });
    const message =
      target.scope === "host"
        ? `rate limit exceeded: this site was scanned ${SCANS_PER_HOUR_PER_HOST} times in the last hour; try again later`
        : "rate limit exceeded: the scanner is at its hourly capacity; try again later";
    return new NextResponse(message, {
      status: 429,
      headers: { "Retry-After": String(target.retryAfterSeconds ?? 3600) },
    });
  }

  if (inFlight >= MAX_CONCURRENT_CI_SCANS) {
    await logScanRequest({ ip, host, mode: `ci-${auth.tier}`, outcome: "busy" });
    return new NextResponse("server busy: too many concurrent scans", {
      status: 429,
      headers: { "Retry-After": "30" },
    });
  }

  const id = newScanId();
  inFlight++;
  try {
    const job = await startScanJob(body.url, "passive", id);
    keepAlive(
      job.done.finally(() => {
        inFlight--;
      }),
    );
  } catch (err) {
    inFlight--;
    throw err;
  }
  await logScanRequest({ ip, host, mode: `ci-${auth.tier}`, outcome: "accepted", scanId: id });

  return NextResponse.json({
    id,
    tier: auth.tier,
    statusUrl: `/api/scan/${id}`,
    resultUrl: `/api/report/${id}?format=json`,
    reportUrl: `/r/${id}`,
  });
}

/** Covers the scan run in after() (SCAN_DEADLINE_MS is 4 minutes). */
export const maxDuration = 300;
