import { NextRequest, NextResponse } from "next/server";
import { normalizeEmail, saveWaitlistEmail } from "@/lib/waitlist";
import type { WaitlistSource } from "@/lib/waitlist";
import {
  checkLimit,
  clientIp,
  RATE_WINDOW_SECONDS,
  WAITLIST_SIGNUPS_PER_HOUR_PER_IP,
} from "@/lib/ratelimit";

/**
 * POST /api/waitlist { email, source?, url? }
 *
 * Early-access capture for continuous monitoring (Phase 0 step 3, ported
 * from the prototype). Storage is Postgres (Neon) when DATABASE_URL is
 * set, else the JSON file in lib/waitlist.ts — no email is sent.
 * Source is landing (homepage form) or report (report-page CTA); anything
 * else is rejected so junk rows can't be injected.
 *
 * Responses: 201 created, 200 { already: true } for a duplicate signup,
 * 400 for an invalid email/source, 429 when rate-limited.
 *
 * Abuse control: per-IP signups/hour via the shared limiter from step 2
 * (WAITLIST_SIGNUPS_PER_HOUR_PER_IP) — Upstash Redis when configured,
 * in-memory otherwise.
 */
export async function POST(req: NextRequest) {
  const limit = await checkLimit(
    `waitlist:${clientIp(req.headers)}`,
    WAITLIST_SIGNUPS_PER_HOUR_PER_IP,
    RATE_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    return new NextResponse("rate limit exceeded", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds ?? RATE_WINDOW_SECONDS) },
    });
  }

  const body = (await req.json().catch(() => null)) as {
    email?: unknown;
    source?: unknown;
    url?: unknown;
  } | null;

  const email = normalizeEmail(body?.email);
  if (!email) {
    return new NextResponse("invalid email", { status: 400 });
  }

  if (body?.source !== undefined && body?.source !== "landing" && body?.source !== "report") {
    return new NextResponse("invalid source", { status: 400 });
  }
  const source: WaitlistSource = body?.source === "report" ? "report" : "landing";

  const url =
    typeof body?.url === "string" && body.url.length > 0 && body.url.length <= 2048
      ? body.url
      : undefined;

  const { created, total } = await saveWaitlistEmail({ email, source, url });
  if (!created) {
    return NextResponse.json({ ok: true, already: true, total }, { status: 200 });
  }
  return NextResponse.json({ ok: true, already: false, total }, { status: 201 });
}
