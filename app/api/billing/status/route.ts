import { NextRequest, NextResponse } from "next/server";
import {
  billingConfigured,
  getSubscription,
  isProSubscriptionStatus,
  planForEmailAsync,
} from "@/lib/billing";
import { publicPlan } from "@/lib/plans";
import { normalizeEmail } from "@/lib/waitlist";

/**
 * GET /api/billing/status?email= — what plan is this email on, and
 * why. Lets the landing/report page render the right state ("Free —
 * upgrade to Pro" vs "Pro until <date> — manage billing") without
 * guessing from a 402. Read-only, no secrets in the response: only
 * the public plan, the subscription status, and the period end.
 */
export async function GET(req: NextRequest) {
  const email = normalizeEmail(new URL(req.url).searchParams.get("email"));
  if (!email) {
    return new NextResponse("a valid email query param is required", { status: 400 });
  }
  const plan = await planForEmailAsync(email);
  const sub = await getSubscription(email).catch(() => null);
  return NextResponse.json({
    email,
    plan: publicPlan(plan),
    billingConfigured: billingConfigured(),
    subscription: sub
      ? {
          status: sub.status,
          isPro: isProSubscriptionStatus(sub.status),
          currentPeriodEnd: sub.currentPeriodEnd,
        }
      : null,
  });
}
