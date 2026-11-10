/**
 * Billing (Phase 0 step 6, ported from the local prototype):
 * Stripe checkout + subscription sync.
 *
 * This replaces the PRO_EMAILS stand-in as the primary Pro lookup.
 * `planForEmailAsync` is what the monitor route now calls: a stored
 * subscription in a Pro status wins; otherwise it falls back to the
 * sync `planForEmail` (PRO_EMAILS env list), so the deployer can still
 * grant Pro manually and local/dev runs without Stripe keep working.
 *
 * Statuses that count as Pro: active, trialing, past_due. past_due
 * keeps Pro during dunning (Stripe retries the payment; the
 * subscription is still live). Everything else — canceled, unpaid,
 * incomplete, incomplete_expired, paused — is Free. A lapsed plan
 * only gates *new* monitor creation: existing monitors keep their
 * interval, per the rule set in lib/plans.ts.
 *
 * Persistence follows the dual-backend pattern: a `subscriptions`
 * table in lib/db.ts when DATABASE_URL is set, a JSON file under
 * PRELAUNCH_DATA_DIR otherwise. Records never carry secrets — only
 * the email, Stripe customer/subscription ids, status, and period end.
 *
 * Env vars (all set at deploy; nothing here creates a Stripe account
 * or a price — those are dashboard steps, test mode first):
 *   STRIPE_SECRET_KEY     secret key (test-mode key for now)
 *   STRIPE_WEBHOOK_SECRET signing secret for /api/billing/webhook
 *   STRIPE_PRICE_ID_PRO   the Pro price id (suggested: $9/mo recurring)
 *   APP_URL               public base URL for checkout redirects
 *                         (falls back to the request origin)
 * No key configured = billing is off: checkout/portal return 503,
 * the webhook refuses unsigned events, and plan lookup falls back
 * to PRO_EMAILS. Nothing in this module ever throws for missing
 * config — callers check `billingConfigured()` first.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { dbConfigured, dbQuery } from "./db.ts";
import { FREE_PLAN, PRO_PLAN, planForEmail, type Plan } from "./plans.ts";

export type SubscriptionStatus = Stripe.Subscription.Status;

/** Stripe statuses that keep Pro access (see header). */
const PRO_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
]);

/** Pure: does this subscription status count as Pro? */
export function isProSubscriptionStatus(status: string): boolean {
  return PRO_STATUSES.has(status);
}

export interface Subscription {
  email: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  /** End of the current billing period, ISO string, or null if unknown. */
  currentPeriodEnd: string | null;
  updatedAt: string;
}

const DATA_DIR = process.env.PRELAUNCH_DATA_DIR ?? join(process.cwd(), ".data");
const FILE = "subscriptions.json";

let stripeClient: Stripe | null = null;

export function billingConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/** Lazily built Stripe client; null when billing is not configured. */
export function getStripe(): Stripe | null {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

/** Pure mapping: a Stripe Subscription object (+ resolved email) to our record. */
export function subscriptionFromStripeObject(
  sub: {
    id: string;
    customer: string | { id: string };
    status: string;
    current_period_end?: number | null;
  },
  email: string,
): Subscription {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  return {
    email: email.trim().toLowerCase(),
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    status: sub.status,
    currentPeriodEnd:
      typeof sub.current_period_end === "number"
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null,
    updatedAt: new Date().toISOString(),
  };
}

function filePath(): string {
  return join(DATA_DIR, FILE);
}

async function listSubscriptionsJson(): Promise<Subscription[]> {
  try {
    const raw = await fs.readFile(filePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Subscription[]) : [];
  } catch {
    return [];
  }
}

async function writeSubscriptionsJson(all: Subscription[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(filePath(), JSON.stringify(all, null, 2));
}

function rowToSubscription(row: {
  email: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  status: string;
  current_period_end: Date | null;
  updated_at: Date;
}): Subscription {
  return {
    email: row.email,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    status: row.status,
    currentPeriodEnd: row.current_period_end
      ? new Date(row.current_period_end).toISOString()
      : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getSubscription(email: string): Promise<Subscription | null> {
  const key = email.trim().toLowerCase();
  if (dbConfigured()) {
    const rows = await dbQuery<{
      email: string;
      stripe_customer_id: string;
      stripe_subscription_id: string;
      status: string;
      current_period_end: Date | null;
      updated_at: Date;
    }>(
      `SELECT email, stripe_customer_id, stripe_subscription_id, status,
              current_period_end, updated_at
       FROM subscriptions WHERE email = $1`,
      [key],
    );
    return rows[0] ? rowToSubscription(rows[0]) : null;
  }
  const all = await listSubscriptionsJson();
  return all.find((s) => s.email === key) ?? null;
}

/**
 * Idempotent upsert keyed on email. A customer can only hold one Pro
 * subscription in this product (one price, one plan), so the latest
 * webhook event for the email is the truth — re-delivered events just
 * rewrite the same row.
 */
export async function upsertSubscription(sub: Subscription): Promise<Subscription> {
  const record: Subscription = { ...sub, updatedAt: new Date().toISOString() };
  if (dbConfigured()) {
    const rows = await dbQuery<{
      email: string;
      stripe_customer_id: string;
      stripe_subscription_id: string;
      status: string;
      current_period_end: Date | null;
      updated_at: Date;
    }>(
      `INSERT INTO subscriptions
         (email, stripe_customer_id, stripe_subscription_id, status, current_period_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = now()
       RETURNING email, stripe_customer_id, stripe_subscription_id, status,
                 current_period_end, updated_at`,
      [
        record.email,
        record.stripeCustomerId,
        record.stripeSubscriptionId,
        record.status,
        record.currentPeriodEnd,
      ],
    );
    return rowToSubscription(rows[0]!);
  }
  const all = await listSubscriptionsJson();
  const idx = all.findIndex((s) => s.email === record.email);
  if (idx >= 0) all[idx] = record;
  else all.push(record);
  await writeSubscriptionsJson(all);
  return record;
}

/**
 * Primary plan lookup (async): a stored subscription in a Pro status
 * is Pro; otherwise fall back to the PRO_EMAILS list. The monitor
 * route calls this instead of the sync planForEmail.
 */
export async function planForEmailAsync(email: string): Promise<Plan> {
  const sub = await getSubscription(email).catch(() => null);
  if (sub && isProSubscriptionStatus(sub.status)) return PRO_PLAN;
  return planForEmail(email);
}

export type BillingEventAction =
  | {
      action: "upsert-subscription";
      stripeSubscription: Stripe.Subscription;
      /** Email when the event carries one; else the route resolves it. */
      email: string | null;
    }
  | {
      action: "fetch-subscription";
      subscriptionId: string;
      customerId: string;
      /** Email when the event carries one (checkout session); else null. */
      email: string | null;
    }
  | { action: "ignore"; reason: string };

/**
 * Pure routing for a verified Stripe webhook event: decides what the
 * route must do next, without any network. The route does the fetch
 * for "fetch-subscription" (checkout.session.completed only carries
 * ids) and the customer lookup + upsert for "upsert-subscription"
 * (the subscription object carries no email).
 *
 * Handled: customer.subscription.created/updated/deleted (the object
 * IS the subscription), checkout.session.completed (subscription id +
 * customer id + email; route fetches the subscription for its
 * status), everything else ignored.
 */
export function handleBillingEvent(
  event: Stripe.Event,
): BillingEventAction {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      return { action: "upsert-subscription", stripeSubscription: sub, email: null };
    }
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (typeof session.subscription !== "string" || !session.subscription) {
        return { action: "ignore", reason: "checkout session has no subscription" };
      }
      if (typeof session.customer !== "string" || !session.customer) {
        return { action: "ignore", reason: "checkout session has no customer" };
      }
      return {
        action: "fetch-subscription",
        subscriptionId: session.subscription,
        customerId: session.customer,
        email: session.customer_email ?? session.customer_details?.email ?? null,
      };
    }
    default:
      return { action: "ignore", reason: `unhandled event type ${event.type}` };
  }
}

/**
 * Store a Stripe subscription against its owner's email. The email
 * comes from the caller when the event carries one (checkout session);
 * otherwise it is resolved from the Stripe customer. Returns null
 * (and stores nothing) when no email can be resolved — a row we
 * cannot key by email could never gate a plan lookup.
 */
export async function syncSubscriptionFromStripe(
  stripe: Stripe,
  sub: Stripe.Subscription,
  emailHint: string | null,
): Promise<Subscription | null> {
  let email = emailHint?.trim().toLowerCase() || null;
  if (!email) {
    const customerId =
      typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (!customer.deleted && customer.email) {
        email = customer.email.trim().toLowerCase();
      }
    } catch {
      // Customer lookup failed: do not store an unkeyed row.
      return null;
    }
  }
  if (!email) return null;
  return upsertSubscription(subscriptionFromStripeObject(sub, email));
}
