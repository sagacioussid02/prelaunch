import { NextRequest, NextResponse } from "next/server";
import {
  getStripe,
  handleBillingEvent,
  syncSubscriptionFromStripe,
} from "@/lib/billing";

/**
 * POST /api/billing/webhook — Stripe event receiver.
 *
 * Fail-closed by design:
 * - No STRIPE_WEBHOOK_SECRET set → 503. Unsigned webhooks must never
 *   mutate subscription state, so an unconfigured webhook refuses
 *   everything instead of accepting unverified events.
 * - Bad signature → 400, event ignored.
 * - A handled event always answers 200 ({ received: true }) even if
 *   the follow-up store write fails — Stripe retries 200-less
 *   deliveries, and a transient DB failure must not turn into a
 *   duplicate-processing storm; the next subscription event re-syncs
 *   the same row idempotently.
 *
 * Handled events (see lib/billing.ts `handleBillingEvent`):
 * customer.subscription.created/updated/deleted and
 * checkout.session.completed. The subscription row is the single
 * source of truth for Pro; the webhook is the only writer besides
 * the deployer-set PRO_EMAILS fallback.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = getStripe();
  if (!stripe || !secret) {
    return new NextResponse(
      "billing webhook is not configured: STRIPE_WEBHOOK_SECRET is not set",
      { status: 503 },
    );
  }

  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new NextResponse("missing stripe-signature header", { status: 400 });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    console.error("billing webhook signature verification failed", err);
    return new NextResponse("invalid webhook signature", { status: 400 });
  }

  const action = handleBillingEvent(event);
  try {
    if (action.action === "upsert-subscription") {
      const stored = await syncSubscriptionFromStripe(
        stripe,
        action.stripeSubscription,
        action.email,
      );
      if (!stored) {
        console.error(
          `billing webhook: could not resolve an email for subscription ${action.stripeSubscription.id} — row not stored`,
        );
      }
    } else if (action.action === "fetch-subscription") {
      const sub = await stripe.subscriptions.retrieve(action.subscriptionId);
      const stored = await syncSubscriptionFromStripe(stripe, sub, action.email);
      if (!stored) {
        console.error(
          `billing webhook: could not resolve an email for subscription ${action.subscriptionId} — row not stored`,
        );
      }
    }
    // "ignore" needs nothing.
  } catch (err) {
    // Log and still answer 200: the next event re-syncs the row.
    console.error("billing webhook follow-up failed", err);
  }
  return NextResponse.json({ received: true });
}
