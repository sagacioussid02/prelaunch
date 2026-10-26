import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { startScanJob } from "@/lib/jobs";
import { newScanId } from "@/lib/store";
import type { ScanMode } from "@/lib/checks/types";

/**
 * POST /api/scan { url, mode? }
 *
 * MVP prototype behavior:
 * - Returns the report id immediately; the scan runs in the background
 *   (fire-and-forget within the function lifetime — prototype simplification).
 * - mode defaults to "passive" (anonymous, read-only). "full" requires the
 *   ownership-proof flow (deploy-hook integration, v2) — accepted here only
 *   with an owner token header in prototype.
 *
 * Abuse controls (security review 2026-10-18, HIGH #2):
 * - Per-IP rate limit: 5 scans/hour (sliding window, in-memory).
 * - Concurrency cap: at most MAX_CONCURRENT_SCANS background scans at once.
 * - SSRF guard in lib/ssrf.ts validates every fetched URL incl. redirects.
 *
 * PROTOTYPE GRADE: the in-memory limiter resets on cold start / doesn't
 * share across instances. Swap in Upstash Ratelimit (Redis-backed) before
 * any public launch, per the deploy checklist.
 */
const SCANS_PER_HOUR_PER_IP = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_CONCURRENT_SCANS = 2;

const hits = new Map<string, number[]>(); // ip -> request timestamps
let inFlight = 0;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const recent = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (recent.length >= SCANS_PER_HOUR_PER_IP) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

/** Timing-safe compare that fails closed when the env var is unset. */
function ownerTokenValid(provided: string | null): boolean {
  const expected = process.env.PRELAUNCH_OWNER_TOKEN;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return new NextResponse(
      `rate limit exceeded: ${SCANS_PER_HOUR_PER_IP} scans/hour per IP`,
      { status: 429, headers: { "Retry-After": "3600" } },
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
    void job.done.finally(() => {
      inFlight--;
    });
  } catch (err) {
    inFlight--;
    throw err;
  }

  return NextResponse.json({ id });
}
