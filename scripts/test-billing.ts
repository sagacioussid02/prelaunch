/**
 * Billing checks (Phase 0 step 6, ported from the prototype suite):
 * Pro-status mapping, webhook event routing, subscription store
 * round-trip, and plan resolution with a stored subscription — all
 * without network or Stripe keys. The store tests run against a temp
 * PRELAUNCH_DATA_DIR set before the billing module is imported (it
 * reads the dir at load time). Route-level coverage (checkout params,
 * portal, webhook signature verify/tamper) lives in
 * scripts/test-billing-routes.ts. JSON fallback store only — the
 * Postgres path stays compile-verified (see PR).
 * Run: node scripts/test-billing.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Stripe from "stripe";

const dir = await mkdtemp(join(tmpdir(), "plc-billing-"));
process.env.PRELAUNCH_DATA_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PRO_EMAILS;

const {
  billingConfigured,
  getStripe,
  handleBillingEvent,
  isProSubscriptionStatus,
  planForEmailAsync,
  getSubscription,
  subscriptionFromStripeObject,
  syncSubscriptionFromStripe,
  upsertSubscription,
} = await import("../lib/billing.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// Unconfigured billing: no client, plan lookup falls back to PRO_EMAILS.
check("billing off without a key", !billingConfigured() && getStripe() === null);

// Pro-status matrix: active/trialing/past_due stay Pro; the rest lapse.
for (const s of ["active", "trialing", "past_due"]) {
  check(`status ${s} is pro`, isProSubscriptionStatus(s));
}
for (const s of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
  check(`status ${s} is free`, !isProSubscriptionStatus(s));
}

// Stripe object -> record mapping (string + object customer, epoch end).
{
  const mapped = subscriptionFromStripeObject(
    {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      current_period_end: 1790000000,
    } as never,
    "  Pro@Example.com ",
  );
  check(
    "mapping: ids, status, normalized email, period end",
    mapped.stripeSubscriptionId === "sub_1" &&
      mapped.stripeCustomerId === "cus_1" &&
      mapped.status === "active" &&
      mapped.email === "pro@example.com" &&
      mapped.currentPeriodEnd === new Date(1790000000 * 1000).toISOString(),
  );
  const noEnd = subscriptionFromStripeObject(
    { id: "sub_2", customer: { id: "cus_2" }, status: "trialing" } as never,
    "t@example.com",
  );
  check(
    "mapping: object customer, missing period end is null",
    noEnd.stripeCustomerId === "cus_2" && noEnd.currentPeriodEnd === null,
  );
}

// Webhook routing: subscription events upsert, checkout fetches,
// everything else is ignored (no network, no store writes here).
{
  const subEvent = {
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_9",
        customer: "cus_9",
        status: "active",
        current_period_end: 1790000000,
      },
    },
  } as unknown as Stripe.Event;
  const routed = handleBillingEvent(subEvent);
  check(
    "event: subscription.updated routes to upsert",
    routed.action === "upsert-subscription" &&
      routed.stripeSubscription.id === "sub_9",
  );
  const deleted = handleBillingEvent({
    ...subEvent,
    type: "customer.subscription.deleted",
  } as unknown as Stripe.Event);
  check("event: subscription.deleted routes to upsert", deleted.action === "upsert-subscription");
}
{
  const checkout = {
    type: "checkout.session.completed",
    data: {
      object: {
        subscription: "sub_10",
        customer: "cus_10",
        customer_email: "buyer@example.com",
      },
    },
  } as unknown as Stripe.Event;
  const routed = handleBillingEvent(checkout);
  check(
    "event: checkout.completed routes to fetch with email",
    routed.action === "fetch-subscription" &&
      routed.subscriptionId === "sub_10" &&
      routed.email === "buyer@example.com",
  );
  const noSub = handleBillingEvent({
    type: "checkout.session.completed",
    data: { object: { subscription: null, customer: "cus_10" } },
  } as unknown as Stripe.Event);
  check("event: checkout without a subscription is ignored", noSub.action === "ignore");
  const failed = handleBillingEvent({
    type: "invoice.payment_failed",
    data: { object: {} },
  } as unknown as Stripe.Event);
  check("event: invoice.payment_failed is ignored", failed.action === "ignore");
  const unknown = handleBillingEvent({
    type: "customer.created",
    data: { object: {} },
  } as unknown as Stripe.Event);
  check("event: unknown type is ignored", unknown.action === "ignore");
}

// Store round-trip + plan resolution (JSON backend, temp dir).
{
  const active = await upsertSubscription({
    email: "sub@example.com",
    stripeCustomerId: "cus_a",
    stripeSubscriptionId: "sub_a",
    status: "active",
    currentPeriodEnd: new Date(1790000000 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  });
  check("store: upsert returns the record", active.email === "sub@example.com");
  const read = await getSubscription("SUB@example.com");
  check("store: read is case-insensitive", read?.status === "active");
  check("plan: active subscription is pro", (await planForEmailAsync("sub@example.com")).id === "pro");

  await upsertSubscription({ ...active, status: "canceled" });
  check("plan: canceled subscription lapses to free", (await planForEmailAsync("sub@example.com")).id === "free");
  check("plan: no subscription and no PRO_EMAILS is free", (await planForEmailAsync("nobody@example.com")).id === "free");

  process.env.PRO_EMAILS = "vip@example.com";
  check("plan: PRO_EMAILS fallback still grants pro", (await planForEmailAsync("vip@example.com")).id === "pro");
  check("plan: stored pro beats an unlisted email", (await planForEmailAsync("sub@example.com")).id === "free");
  delete process.env.PRO_EMAILS;
}

// syncSubscriptionFromStripe resolves the email from the customer
// when the event carries none; an unresolvable email stores nothing.
{
  const fakeStripe = {
    customers: {
      retrieve: async (id: string) => ({ id, email: "owner@example.com", deleted: false }),
    },
  } as unknown as Stripe;
  const stored = await syncSubscriptionFromStripe(
    fakeStripe,
    {
      id: "sub_sync",
      customer: "cus_sync",
      status: "trialing",
      current_period_end: 1790000000,
    } as unknown as Stripe.Subscription,
    null,
  );
  check(
    "sync: email resolved from customer, row stored",
    stored?.email === "owner@example.com" && stored?.status === "trialing",
  );
  check("sync: stored row is readable", (await getSubscription("owner@example.com"))?.stripeSubscriptionId === "sub_sync");

  const deadStripe = {
    customers: {
      retrieve: async () => {
        throw new Error("customer gone");
      },
    },
  } as unknown as Stripe;
  const missed = await syncSubscriptionFromStripe(
    deadStripe,
    { id: "sub_lost", customer: "cus_lost", status: "active" } as unknown as Stripe.Subscription,
    null,
  );
  check("sync: unresolvable email stores nothing", missed === null);
  check(
    "sync: failed sync left the earlier row untouched",
    (await getSubscription("owner@example.com"))?.stripeSubscriptionId === "sub_sync",
  );
}

await rm(dir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log("all billing checks pass");
