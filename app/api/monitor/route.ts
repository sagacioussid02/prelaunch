import { NextRequest, NextResponse } from "next/server";
import {
  createMonitor,
  findActiveMonitorByEmailUrl,
  listActiveMonitorsByEmail,
} from "@/lib/monitor";
import { mintRunGrant } from "@/lib/runlink";
import {
  checkLimit,
  clientIp,
  MONITORS_PER_HOUR_PER_IP,
  RATE_WINDOW_SECONDS,
} from "@/lib/ratelimit";
import { normalizeUrl } from "@/lib/scanner";
import { normalizeEmail } from "@/lib/waitlist";
import { planForEmailAsync } from "@/lib/billing";
import {
  FREE_PLAN,
  checkCreateAllowed,
  clampIntervalForPlan,
  publicPlan,
  type Plan,
} from "@/lib/plans";
import type { ScanMode } from "@/lib/checks/types";

/**
 * POST /api/monitor { url, alertWebhook?, email?, intervalMinutes?, regressionOnly?, mode? }
 *   → 201 { id, dashboard, deployHook, plan, usage?, note? } (the deploy
 *   token in deployHook is shown once). Creation previously answered
 *   200 here; step 5 makes it 201, matching the prototype route.
 *   `dashboard` carries a signed 1-hour "Run now" grant when
 *   PRELAUNCH_LINK_SECRET is set (lib/runlink.ts, issue #6); after that,
 *   manual runs need the deploy token. The 409 duplicate response links
 *   the existing monitor WITHOUT a grant: the caller hasn't proven they own it.
 *
 * `email` opts the monitor into regression email (lib/notify.ts) AND
 * identifies the owner for plan limits (lib/plans.ts, step 5): with
 * an email, creation is gated — duplicate owner+URL → 409, plan
 * monitor cap or full-mode-on-Free → 402 with { code, plan, limit,
 * upgrade } so the client can render an upgrade prompt. The plan now
 * resolves via lib/billing.ts `planForEmailAsync` (step 6) — a
 * stored Stripe subscription in a Pro status wins; the PRO_EMAILS
 * list remains the fallback for deployer-granted Pro. The cadence
 * is raised to the plan floor (Free: daily) with a note in the
 * response, never silently. `intervalMinutes` otherwise sets the
 * scheduled-runner cadence (clamped to 60–10080, default daily).
 * Domain verification (claim/verify) is what enables scheduled
 * runs — creation alone never does.
 *
 * Without an email there is no owner identity to count against, so
 * creation proceeds as before (token-owned monitor, recorded on the
 * Free plan) — the repo has no owner-token concept to bypass with;
 * this mirrors the prototype, where plan gating keys off the email
 * identity (or an owner token this codebase doesn't have).
 *
 * Abuse control (issue #6): per-IP creation limit of 10/hour via
 * lib/ratelimit.ts — Upstash Redis counters shared across instances
 * when configured, in-memory sliding window fallback otherwise,
 * fail-closed if Redis errors.
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
    mode?: string;
  } | null;
  if (!body?.url) return new NextResponse("missing url", { status: 400 });

  const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;

  // Plan gate (only when an email identifies the owner).
  let email: string | null = null;
  let plan: Plan = FREE_PLAN;
  let existingCount = 0;
  if (body.email != null && String(body.email).trim() !== "") {
    email = normalizeEmail(body.email);
    if (!email) return new NextResponse("invalid email", { status: 400 });
    plan = await planForEmailAsync(email);
    const mode: ScanMode = body.mode === "full" ? "full" : "passive";
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeUrl(body.url);
    } catch {
      return new NextResponse("invalid url", { status: 400 });
    }
    const existing = await findActiveMonitorByEmailUrl(email, normalizedUrl);
    existingCount = (await listActiveMonitorsByEmail(email)).length;
    const gate = checkCreateAllowed(plan, {
      existingCount,
      duplicate: existing !== null,
      mode,
    });
    if (!gate.allowed) {
      const status = gate.code === "duplicate" ? 409 : 402;
      return NextResponse.json(
        {
          error: gate.reason,
          code: gate.code === "limit" ? "plan_limit" : gate.code,
          plan: publicPlan(plan),
          limit: plan.maxMonitors,
          ...(plan.id === "free" && gate.code !== "duplicate"
            ? {
                upgrade:
                  "Pro allows 10 monitors, full-mode scans and hourly checks. Upgrade via POST /api/billing/checkout.",
              }
            : {}),
          ...(existing
            ? { monitorId: existing.id, dashboard: `${origin}/m/${existing.id}` }
            : {}),
        },
        { status },
      );
    }
  }

  try {
    const m = await createMonitor(body.url, body.alertWebhook, {
      email,
      intervalMinutes: body.intervalMinutes,
      regressionOnly: body.regressionOnly,
      ...(email ? { plan } : {}),
    });
    const requestedInterval =
      typeof body.intervalMinutes === "number" ? body.intervalMinutes : 1440;
    const notes: string[] = [];
    if (email && clampIntervalForPlan(plan, requestedInterval) > requestedInterval) {
      notes.push(
        `interval raised to ${clampIntervalForPlan(plan, requestedInterval)} minutes (the ${plan.name} plan minimum)`,
      );
    }
    if (email && body.mode === "full" && plan.allowFullMode) {
      notes.push(
        "monitors run passive scans on deploy and on schedule in this build; the Pro full-mode allowance applies to one-off scans",
      );
    }
    // Signed 1-hour grant so the creator's dashboard link can "Run now"
    // without pasting the token (issue #6). Absent when PRELAUNCH_LINK_SECRET is unset.
    const grant = mintRunGrant(m.id);
    return NextResponse.json({
      id: m.id,
      url: m.url,
      dashboard: `${origin}/m/${m.id}${grant ? `?grant=${encodeURIComponent(grant)}` : ""}`,
      deployHook: `${origin}/api/monitor/${m.id}/deploy?token=${m.token}`,
      plan: publicPlan(plan),
      ...(email
        ? { usage: { monitors: existingCount + 1, maxMonitors: plan.maxMonitors } }
        : {}),
      ...(notes.length ? { note: notes.join(". ") + "." } : {}),
    }, { status: 201 });
  } catch (err) {
    return new NextResponse(String((err as Error).message ?? err).slice(0, 200), { status: 400 });
  }
}
