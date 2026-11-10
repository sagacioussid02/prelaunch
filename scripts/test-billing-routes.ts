/**
 * Billing route checks (Phase 0 step 6): the four /api/billing/*
 * handlers exercised end to end — checkout session construction,
 * portal session, webhook signature verification + tamper rejection,
 * and the resulting subscription sync / plan flips.
 *
 * No Stripe account or network: the module hook maps the bare
 * "stripe" specifier to a wrapper whose network resources
 * (customers, checkout sessions, portal sessions, subscription
 * retrieve) are in-memory stubs that record their call params, while
 * `webhooks` is the REAL stripe-node implementation — signature
 * verification and header generation run Stripe's own HMAC code,
 * with fixture secrets assembled at runtime (never literal key
 * strings in source; GitHub secret scanning rejects those).
 *
 * Self-contained: temp PRELAUNCH_DATA_DIR, JSON fallback store only
 * (the Postgres path stays compile-verified — see PR).
 * Run: node scripts/test-billing-routes.ts
 */
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "pl-billing-routes-"));
process.env.PRELAUNCH_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.PRO_EMAILS;
delete process.env.APP_URL;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.STRIPE_PRICE_ID_PRO;

// Fixture secrets, assembled at runtime so no literal key-shaped
// string ever appears in source.
const SECRET_KEY = ["sk", "test", randomBytes(12).toString("hex")].join("_");
const WEBHOOK_SECRET = ["whsec", randomBytes(12).toString("hex")].join("_");
const PRICE_ID = ["price", randomBytes(8).toString("hex")].join("_");

const rootUrl = new URL("../", import.meta.url).href;

// Stripe wrapper: real SDK for webhooks, stubbed network resources.
const wrapperFile = join(dataDir, "fake-stripe.mjs");
await fs.writeFile(
  wrapperFile,
  `
import RealStripe from ${JSON.stringify(rootUrl + "node_modules/stripe/esm/stripe.esm.node.js")};
const real = new RealStripe("test-key-for-signature-verification");
export default class FakeStripe {
  static calls = {
    customersList: [], customersCreate: [], customersRetrieve: [],
    checkoutCreate: [], portalCreate: [], subscriptionsRetrieve: [],
  };
  static customersByEmail = new Map();
  static subscriptionToReturn = null;
  static customerEmail = null;
  constructor() {
    const S = FakeStripe;
    this.customers = {
      list: async (params) => {
        S.calls.customersList.push(params);
        const c = S.customersByEmail.get(params?.email);
        return { data: c ? [c] : [] };
      },
      create: async (params) => {
        S.calls.customersCreate.push(params);
        const c = { id: "cus_created_" + S.calls.customersCreate.length, email: params.email, deleted: false };
        S.customersByEmail.set(params.email, c);
        return c;
      },
      retrieve: async (id) => {
        S.calls.customersRetrieve.push(id);
        return { id, email: S.customerEmail, deleted: false };
      },
    };
    this.checkout = { sessions: { create: async (params) => {
      S.calls.checkoutCreate.push(params);
      return { id: "cs_fake_1", url: "https://checkout.example/cs_fake_1" };
    } } };
    this.billingPortal = { sessions: { create: async (params) => {
      S.calls.portalCreate.push(params);
      return { id: "bps_fake_1", url: "https://portal.example/bps_fake_1" };
    } } };
    this.subscriptions = { retrieve: async (id) => {
      S.calls.subscriptionsRetrieve.push(id);
      return S.subscriptionToReturn;
    } };
    this.webhooks = real.webhooks;
  }
}
`,
);

// "@/..." alias hook (same as test-waitlist.ts) + the "stripe" map.
const hooksFile = join(dataDir, "alias-hooks.mjs");
await fs.writeFile(
  hooksFile,
  `
import { existsSync } from "node:fs";
const ROOT = ${JSON.stringify(rootUrl)};
const WRAPPER = ${JSON.stringify(pathToFileURL(wrapperFile).href)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "stripe") {
    return { url: WRAPPER, shortCircuit: true };
  }
  if (specifier === "next/server") {
    return { url: ROOT + "node_modules/next/server.js", shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    for (const suffix of [".ts", ".tsx", ".js", ".mjs"]) {
      const url = ROOT + rel + suffix;
      if (existsSync(new URL(url))) return { url, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
`,
);
register(pathToFileURL(hooksFile));

const FakeStripe = (await import(pathToFileURL(wrapperFile).href)).default;
const RealStripe = (await import(rootUrl + "node_modules/stripe/esm/stripe.esm.node.js")).default;
const signer = new RealStripe("test-key-for-signature-verification");

const { NextRequest } = await import("next/server");
const { getSubscription, planForEmailAsync, upsertSubscription } =
  await import("../lib/billing.ts");
const checkoutRoute = await import("../app/api/billing/checkout/route.ts");
const portalRoute = await import("../app/api/billing/portal/route.ts");
const webhookRoute = await import("../app/api/billing/webhook/route.ts");
const statusRoute = await import("../app/api/billing/status/route.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

function postJson(
  route: { POST: (req: never) => Promise<Response> },
  path: string,
  body: unknown,
  ip: string,
): Promise<Response> {
  return route.POST(
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }) as never,
  );
}

/* ---------- unconfigured: everything refuses cleanly ---------- */

{
  const res = await postJson(checkoutRoute, "/api/billing/checkout", { email: "a@example.com" }, "10.1.0.1");
  check("unconfigured: checkout 503", res.status === 503);
  const pres = await postJson(portalRoute, "/api/billing/portal", { email: "a@example.com" }, "10.1.0.2");
  check("unconfigured: portal 503", pres.status === 503);
  const wres = await webhookRoute.POST(
    new NextRequest("http://localhost/api/billing/webhook", { method: "POST", body: "{}" }),
  );
  check("unconfigured: webhook 503 (no secret, no client)", wres.status === 503);
  const sres = await statusRoute.GET(
    new NextRequest("http://localhost/api/billing/status?email=a@example.com"),
  );
  const sbody = (await sres.json()) as { plan: { id: string }; billingConfigured: boolean; subscription: unknown };
  check(
    "unconfigured: status reports free + billing off",
    sres.status === 200 && sbody.plan.id === "free" && sbody.billingConfigured === false && sbody.subscription === null,
  );
}

/* ---------- checkout: params, customer reuse, config gates ---------- */

process.env.STRIPE_SECRET_KEY = SECRET_KEY;
{
  const noPrice = await postJson(checkoutRoute, "/api/billing/checkout", { email: "buyer@example.com" }, "10.2.0.2");
  check("checkout: no price configured 503", noPrice.status === 503);

  process.env.STRIPE_PRICE_ID_PRO = PRICE_ID;
  const bad = await postJson(checkoutRoute, "/api/billing/checkout", { email: "not-an-email" }, "10.2.0.1");
  check("checkout: invalid email 400", bad.status === 400);
  const ok = await postJson(checkoutRoute, "/api/billing/checkout", { email: "buyer@example.com" }, "10.2.0.3");
  const okBody = (await ok.json()) as { url?: string };
  check("checkout: 200 with hosted url", ok.status === 200 && okBody.url === "https://checkout.example/cs_fake_1");
  check(
    "checkout: customer created once for the email",
    FakeStripe.calls.customersCreate.length === 1 &&
      FakeStripe.calls.customersCreate[0].email === "buyer@example.com",
  );
  const params = FakeStripe.calls.checkoutCreate[0] as {
    mode: string;
    customer: string;
    line_items: { price: string; quantity: number }[];
    success_url: string;
    cancel_url: string;
    metadata: { email: string };
  };
  check(
    "checkout: session params (subscription mode, price, urls, metadata)",
    params.mode === "subscription" &&
      params.customer === "cus_created_1" &&
      params.line_items[0]?.price === PRICE_ID &&
      params.line_items[0]?.quantity === 1 &&
      params.success_url === "http://localhost/?billing=success&session_id={CHECKOUT_SESSION_ID}" &&
      params.cancel_url === "http://localhost/?billing=cancelled" &&
      params.metadata.email === "buyer@example.com",
    JSON.stringify(params),
  );

  const again = await postJson(checkoutRoute, "/api/billing/checkout", { email: "buyer@example.com" }, "10.2.0.4");
  check(
    "checkout: returning email reuses the customer",
    again.status === 200 &&
      FakeStripe.calls.customersCreate.length === 1 &&
      FakeStripe.calls.checkoutCreate.length === 2 &&
      (FakeStripe.calls.checkoutCreate[1] as { customer: string }).customer === "cus_created_1",
  );
}

/* ---------- portal: no-customer 404, stored customer session ---------- */

{
  const none = await postJson(portalRoute, "/api/billing/portal", { email: "ghost@example.com" }, "10.3.0.1");
  check("portal: no subscription stored 404", none.status === 404);

  await upsertSubscription({
    email: "portal@example.com",
    stripeCustomerId: "cus_portal_1",
    stripeSubscriptionId: "sub_portal_1",
    status: "active",
    currentPeriodEnd: null,
    updatedAt: new Date().toISOString(),
  });
  const ok = await postJson(portalRoute, "/api/billing/portal", { email: "portal@example.com" }, "10.3.0.2");
  const body = (await ok.json()) as { url?: string };
  const params = FakeStripe.calls.portalCreate[0] as { customer: string; return_url: string };
  check(
    "portal: session for the stored customer",
    ok.status === 200 && body.url === "https://portal.example/bps_fake_1" &&
      params.customer === "cus_portal_1" && params.return_url === "http://localhost/?billing=managed",
  );
}

/* ---------- webhook: secret gate, signature verify + tamper ---------- */

async function postWebhook(payload: string, signature: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["stripe-signature"] = signature;
  return webhookRoute.POST(
    new NextRequest("http://localhost/api/billing/webhook", { method: "POST", headers, body: payload }),
  );
}
const sign = (payload: string): string =>
  signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

{
  const noSecret = await postWebhook("{}", null);
  check("webhook: no webhook secret configured 503", noSecret.status === 503);

  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const noSig = await postWebhook("{}", null);
  check("webhook: missing signature header 400", noSig.status === 400);

  // Subscription created → stored under the customer's email → Pro.
  FakeStripe.customerEmail = "hook@example.com";
  const created = JSON.stringify({
    id: "evt_created",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_hook_1",
        customer: "cus_hook_1",
        status: "active",
        current_period_end: 1790000000,
      },
    },
  });
  const res = await postWebhook(created, sign(created));
  const stored = await getSubscription("hook@example.com");
  check(
    "webhook: signed subscription.created stores the row",
    res.status === 200 && stored?.stripeSubscriptionId === "sub_hook_1" && stored?.status === "active",
  );
  check("webhook: plan flips to pro", (await planForEmailAsync("hook@example.com")).id === "pro");

  // Tampered body (status flipped after signing) → 400, state intact.
  const canceled = JSON.stringify({
    id: "evt_updated",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_hook_1",
        customer: "cus_hook_1",
        status: "canceled",
        current_period_end: 1790000000,
      },
    },
  });
  const tampered = await postWebhook(canceled, sign(created));
  check(
    "webhook: tampered payload rejected 400, row untouched",
    tampered.status === 400 &&
      (await getSubscription("hook@example.com"))?.status === "active" &&
      (await planForEmailAsync("hook@example.com")).id === "pro",
  );

  // Properly signed cancellation → stored → plan lapses to free.
  const okCancel = await postWebhook(canceled, sign(canceled));
  check(
    "webhook: signed cancellation lapses the plan to free",
    okCancel.status === 200 &&
      (await getSubscription("hook@example.com"))?.status === "canceled" &&
      (await planForEmailAsync("hook@example.com")).id === "free",
  );

  // checkout.session.completed → route fetches the subscription by id.
  FakeStripe.subscriptionToReturn = {
    id: "sub_hook_2",
    customer: "cus_hook_2",
    status: "active",
    current_period_end: 1790000000,
  };
  const completed = JSON.stringify({
    id: "evt_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        subscription: "sub_hook_2",
        customer: "cus_hook_2",
        customer_email: "buyer2@example.com",
      },
    },
  });
  const cres = await postWebhook(completed, sign(completed));
  check(
    "webhook: checkout.completed fetches + stores, plan pro",
    cres.status === 200 &&
      FakeStripe.calls.subscriptionsRetrieve.includes("sub_hook_2") &&
      (await getSubscription("buyer2@example.com"))?.status === "active" &&
      (await planForEmailAsync("buyer2@example.com")).id === "pro",
  );

  // Unknown event types are acknowledged, state unchanged.
  const unknown = JSON.stringify({ id: "evt_other", type: "invoice.payment_failed", data: { object: {} } });
  const ures = await postWebhook(unknown, sign(unknown));
  check(
    "webhook: unknown type 200, no state change",
    ures.status === 200 && (await planForEmailAsync("buyer2@example.com")).id === "pro",
  );

  // Status route reflects the synced subscription.
  const sres = await statusRoute.GET(
    new NextRequest("http://localhost/api/billing/status?email=buyer2@example.com"),
  );
  const sbody = (await sres.json()) as {
    plan: { id: string };
    subscription: { status: string; isPro: boolean } | null;
  };
  check(
    "status: pro with active subscription",
    sres.status === 200 && sbody.plan.id === "pro" && sbody.subscription?.status === "active" && sbody.subscription?.isPro === true,
  );
}

if (failures > 0) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log("all billing route checks pass");
