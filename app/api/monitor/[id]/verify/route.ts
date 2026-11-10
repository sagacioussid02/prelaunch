import { NextRequest, NextResponse } from "next/server";
import { getMonitor, verifyDomainOwnership } from "@/lib/monitor";
import { checkLimit, clientIp, RATE_WINDOW_SECONDS } from "@/lib/ratelimit";

const VERIFIES_PER_HOUR_PER_IP = 10;

/**
 * POST /api/monitor/{id}/verify — fetch the well-known file from the
 * monitored site and, on an exact token match, mark the monitor
 * verified (which enables scheduled runs). No monitor token required:
 * serving the file IS the proof. A mismatch or unreachable file returns
 * verified:false with a reason (200, not an error) — verification is a
 * state to retry, not a failed request.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ip = clientIp(req.headers);
  const limit = await checkLimit(`monitor-verify:${ip}`, VERIFIES_PER_HOUR_PER_IP, RATE_WINDOW_SECONDS);
  if (!limit.allowed) {
    return new NextResponse(`rate limit exceeded: ${VERIFIES_PER_HOUR_PER_IP} verifications/hour per IP`, {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds ?? 3600) },
    });
  }
  try {
    const { verified, reason } = await verifyDomainOwnership(id);
    const monitor = await getMonitor(id);
    return NextResponse.json({ monitor, verified, reason });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (msg === "monitor not found") return new NextResponse(msg, { status: 404 });
    console.error("monitor verify failed", id, err);
    return new NextResponse("monitor verify failed", { status: 500 });
  }
}
