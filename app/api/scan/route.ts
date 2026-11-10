import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { startScanJob } from "@/lib/jobs";
import { keepAlive } from "@/lib/background";
import { newScanId } from "@/lib/store";
import {
  checkLimit,
  clientIp,
  RATE_WINDOW_SECONDS,
  SCANS_PER_HOUR_PER_IP,
} from "@/lib/ratelimit";
import type { ScanMode } from "@/lib/checks/types";

/**
 * POST /api/scan { url, mode? }
 *
 * Behavior:
 * - Returns the report id immediately; the scan runs in the background and
 *   is kept alive past the response with Next's after() (lib/background.ts,
 *   issue #4). A scan that overruns its deadline, or whose function is
 *   frozen anyway, ends as "failed" with a readable reason (lib/jobs.ts,
 *   lib/scanstatus.ts).
 * - mode defaults to "passive" (anonymous, read-only). "full" requires the
 *   ownership-proof flow (deploy-hook integration, v2) — accepted here only
 *   with an owner token header in prototype.
 *
 * Abuse controls (security review 2026-10-18, HIGH #2; issue #6):
 * - Per-IP rate limit: 5 scans/hour via lib/ratelimit.ts — Upstash Redis
 *   counters shared across instances when configured, in-memory sliding
 *   window fallback otherwise, fail-closed if Redis errors.
 * - Concurrency cap: at most MAX_CONCURRENT_SCANS background scans at once
 *   (still in-process; moving it into a queue is issue #4 / Phase 1).
 * - SSRF guard in lib/ssrf.ts validates every fetched URL incl. redirects.
 */
const MAX_CONCURRENT_SCANS = 2;

let inFlight = 0;

/** Timing-safe compare that fails closed when the env var is unset. */
function ownerTokenValid(provided: string | null): boolean {
  const expected = process.env.PRELAUNCH_OWNER_TOKEN;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const limit = await checkLimit(
    `scan:${ip}`,
    SCANS_PER_HOUR_PER_IP,
    RATE_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    return new NextResponse(
      `rate limit exceeded: ${SCANS_PER_HOUR_PER_IP} scans/hour per IP`,
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds ?? 3600) },
      },
    );
  }
  if (inFlight >= MAX_CONCURRENT_SCANS) {
    return new NextResponse("server busy: too many concurrent scans", {
      status: 429,
      headers: { "Retry-After": "30" },
    });
  }

  const body = (await req.json().catch(() => null)) as { url?: string; mode?: ScanMode } | null;
  if (!body?.url) {
    return new NextResponse("missing url", { status: 400 });
  }

  let mode: ScanMode = "passive";
  if (body.mode === "full") {
    // Prototype gate: full-suite scans need the owner token until the
    // deploy-hook ownership flow exists. Env var, never shipped to client.
    if (!ownerTokenValid(req.headers.get("x-prelaunch-owner-token"))) {
      return new NextResponse("full mode requires ownership proof", { status: 403 });
    }
    mode = "full";
  }

  const id = newScanId();
  // Concurrency-counted so one caller can't exhaust CPU/network with parallel scans.
  inFlight++;
  try {
    const job = await startScanJob(body.url, mode, id);
    keepAlive(
      job.done.finally(() => {
        inFlight--;
      }),
    );
  } catch (err) {
    inFlight--;
    throw err;
  }

  return NextResponse.json({ id });
}

/** Covers the scan run in after() (SCAN_DEADLINE_MS is 4 minutes). */
export const maxDuration = 300;
