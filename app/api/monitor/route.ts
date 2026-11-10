import { NextRequest, NextResponse } from "next/server";
import { createMonitor } from "@/lib/monitor";
import {
  checkLimit,
  clientIp,
  MONITORS_PER_HOUR_PER_IP,
  RATE_WINDOW_SECONDS,
} from "@/lib/ratelimit";

/**
 * POST /api/monitor { url, alertWebhook?, email?, intervalMinutes?, regressionOnly? }
 *   → { id, token, deployHook } (token is shown once).
 *
 * `email` opts the monitor into regression email (lib/notify.ts);
 * `intervalMinutes` sets the scheduled-runner cadence (clamped to
 * 60–10080, default daily). Domain verification (claim/verify) is what
 * enables scheduled runs — creation alone never does.
 *
 * Abuse control (issue #6): per-IP creation limit of 10/hour via
 * lib/ratelimit.ts — Upstash Redis counters shared across instances when
 * configured, in-memory sliding window fallback otherwise, fail-closed if
 * Redis errors.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const limit = await checkLimit(
    `monitor:${ip}`,
    MONITORS_PER_HOUR_PER_IP,
    RATE_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    return new NextResponse("rate limit exceeded", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds ?? 3600) },
    });
  }

  const body = (await req.json().catch(() => null)) as {
    url?: string;
    alertWebhook?: string;
    email?: string;
    intervalMinutes?: number;
    regressionOnly?: boolean;
  } | null;
  if (!body?.url) return new NextResponse("missing url", { status: 400 });
  try {
    const m = await createMonitor(body.url, body.alertWebhook, {
      email: body.email,
      intervalMinutes: body.intervalMinutes,
      regressionOnly: body.regressionOnly,
    });
    const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
    return NextResponse.json({
      id: m.id,
      url: m.url,
      dashboard: `${origin}/m/${m.id}`,
      deployHook: `${origin}/api/monitor/${m.id}/deploy?token=${m.token}`,
    });
  } catch (err) {
    return new NextResponse(String((err as Error).message ?? err).slice(0, 200), { status: 400 });
  }
}
