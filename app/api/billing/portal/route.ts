import { NextRequest, NextResponse } from "next/server";
import { getStripe, getSubscription } from "@/lib/billing";
import { checkLimit, clientIp } from "@/lib/ratelimit";
import { normalizeEmail } from "@/lib/waitlist";

/**
 * POST /api/billing/portal { email } — self-serve subscription
 * management. Creates a Stripe Billing Portal session for the
 * customer stored against the email, so a Pro user can update their
 * card, change plan, or cancel without us building that UI.
 *
 * 503 when billing is not configured; 404 when no subscription is
 * stored for the email (nothing to manage — they are Free, or paying
 * under a different address). Rate-limited 10/hr/IP.
 */
const PORTALS_PER_HOUR_PER_IP = 10;

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const limit = await checkLimit(
    `billing-portal:${ip}`,
    PORTALS_PER_HOUR_PER_IP,
    3600,
  );
  if (!limit.allowed) {
    return new NextResponse(
      `rate limit exceeded: ${PORTALS_PER_HOUR_PER_IP} portal sessions/hour per IP`,
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 3600) } },
    );
  }
  const stripe = getStripe();
  if (!stripe) {
    return new NextResponse("billing is not configured: STRIPE_SECRET_KEY is not set", {
      status: 503,
    });
  }
  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = normalizeEmail(body?.email);
  if (!email) {
    return new NextResponse("a valid email is required", { status: 400 });
  }
  const sub = await getSubscription(email).catch(() => null);
  if (!sub) {
    return new NextResponse("no subscription found for this email", { status: 404 });
  }
  try {
    const baseUrl = process.env.APP_URL ?? new URL(req.url).origin;
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${baseUrl}/?billing=managed`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("billing portal failed", err);
    return new NextResponse("could not open the billing portal — try again later", {
      status: 502,
    });
  }
}
