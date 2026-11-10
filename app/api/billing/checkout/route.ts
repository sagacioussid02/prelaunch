import { NextRequest, NextResponse } from "next/server";
import { billingConfigured, getStripe } from "@/lib/billing";
import { checkLimit, clientIp } from "@/lib/ratelimit";
import { normalizeEmail } from "@/lib/waitlist";

/**
 * POST /api/billing/checkout { email } — start a Pro subscription.
 *
 * Creates (or reuses, by email) a Stripe customer, then a Checkout
 * session in subscription mode for STRIPE_PRICE_ID_PRO. Returns the
 * hosted checkout URL; the browser redirects there. Success lands
 * back on `/?billing=success`, cancel on `/?billing=cancelled`
 * (APP_URL when set, else the request origin).
 *
 * 503 when billing is not configured (no STRIPE_SECRET_KEY) or no
 * Pro price is set (no STRIPE_PRICE_ID_PRO) — the message names the
 * missing var so a deploy misconfiguration is obvious, not silent.
 * Rate-limited 10/hr/IP; checkout itself is idempotent per call
 * (each call mints a fresh session, which is the correct shape —
 * re-clicking "upgrade" after abandoning a session is normal).
 */
const CHECKOUTS_PER_HOUR_PER_IP = 10;

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const limit = await checkLimit(
    `billing-checkout:${ip}`,
    CHECKOUTS_PER_HOUR_PER_IP,
    3600,
  );
  if (!limit.allowed) {
    return new NextResponse(
      `rate limit exceeded: ${CHECKOUTS_PER_HOUR_PER_IP} checkouts/hour per IP`,
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 3600) } },
    );
  }
  const stripe = getStripe();
  if (!stripe || !billingConfigured()) {
    return new NextResponse("billing is not configured: STRIPE_SECRET_KEY is not set", {
      status: 503,
    });
  }
  const priceId = process.env.STRIPE_PRICE_ID_PRO;
  if (!priceId) {
    return new NextResponse("billing is not configured: STRIPE_PRICE_ID_PRO is not set", {
      status: 503,
    });
  }
  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = normalizeEmail(body?.email);
  if (!email) {
    return new NextResponse("a valid email is required to start checkout", { status: 400 });
  }

  try {
    // Reuse the customer when one already exists for this email, so a
    // returning user does not accumulate duplicate Stripe customers.
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customerId =
      existing.data[0]?.id ??
      (await stripe.customers.create({ email })).id;

    const baseUrl =
      process.env.APP_URL ?? new URL(req.url).origin;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?billing=cancelled`,
      metadata: { email },
    });
    if (!session.url) {
      return new NextResponse("stripe did not return a checkout url", { status: 502 });
    }
    return NextResponse.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    // A Stripe failure must not leak the SDK error (it can contain
    // account details) — log server-side, return a generic 502.
    console.error("billing checkout failed", err);
    return new NextResponse("could not start checkout — try again later", { status: 502 });
  }
}
