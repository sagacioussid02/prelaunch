import { NextRequest, NextResponse } from "next/server";
import { getMonitor, requestVerificationClaim } from "@/lib/monitor";
import { checkLimit, clientIp, RATE_WINDOW_SECONDS } from "@/lib/ratelimit";

const CLAIMS_PER_HOUR_PER_IP = 10;

/**
 * POST /api/monitor/{id}/claim — issue a domain-verification token.
 *
 * No monitor token required: the claim token is useless without control
 * of the site (it must be published at /.well-known/prelaunch-check.txt),
 * so issuing it proves nothing by itself. Rate-limited per IP so a
 * caller cannot churn tokens to block the real owner from verifying.
 * The response includes the exact path and full URL to publish; the
 * token itself is never returned by any GET.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ip = clientIp(req.headers);
  const limit = await checkLimit(`monitor-claim:${ip}`, CLAIMS_PER_HOUR_PER_IP, RATE_WINDOW_SECONDS);
  if (!limit.allowed) {
    return new NextResponse(`rate limit exceeded: ${CLAIMS_PER_HOUR_PER_IP} claims/hour per IP`, {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds ?? 3600) },
    });
  }
  try {
    const { token, path, url } = await requestVerificationClaim(id);
    const monitor = await getMonitor(id);
    return NextResponse.json({
      monitor,
      verification: {
        token,
        path,
        url,
        instructions: `Publish the token as the entire body of ${url}, then POST /api/monitor/${id}/verify.`,
      },
    });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (msg === "monitor not found") return new NextResponse(msg, { status: 404 });
    console.error("monitor claim failed", id, err);
    return new NextResponse("monitor claim failed", { status: 500 });
  }
}
