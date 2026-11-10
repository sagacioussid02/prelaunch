/**
 * Plan limits (Phase 0 step 5, ported from the local prototype).
 *
 * The monitoring tier is the paid product: free one-off audits drive
 * adoption, continuous monitoring is the upsell. Plans gate monitor
 * CREATION only — the POST /api/monitor route enforces them via
 * checkCreateAllowed below. Manual runs, deploy webhooks, claim/verify
 * and the scheduled runner are never plan-gated, and existing monitors
 * are never retroactively throttled: a monitor created on Pro keeps
 * its interval if the plan later lapses (downgrade handling belongs
 * to billing, step 6).
 *
 * Free: 1 monitor, passive scans only, daily checks (1440 min floor).
 * Pro:  10 monitors, full scans allowed, hourly checks (60 min floor).
 *
 * Plan resolution in this step is the PRO_EMAILS env list only (the
 * deployer-granted stand-in). Step 6 (billing) swaps the lookup
 * source for a stored-subscription check; the route keys off Plan,
 * not off the env var, so that change won't touch the gate.
 *
 * Counting semantics live in lib/monitor.ts: listActiveMonitorsByEmail
 * counts the owner's monitors with enabled !== false — the repo's
 * analogue of the prototype's `active` flag (disabled monitors do not
 * consume a plan slot and do not trigger the duplicate guard).
 */

import type { ScanMode } from "./checks/types.ts";

export type PlanId = "free" | "pro";

export interface Plan {
  id: PlanId;
  name: string;
  /** Max active monitors on this plan. */
  maxMonitors: number;
  /** Fastest allowed scheduled cadence, in minutes. */
  minIntervalMinutes: number;
  /** Whether full-mode (ownership-gated) scans may be monitored. */
  allowFullMode: boolean;
}

export const FREE_PLAN: Plan = {
  id: "free",
  name: "Free",
  maxMonitors: 1,
  minIntervalMinutes: 1440,
  allowFullMode: false,
};

export const PRO_PLAN: Plan = {
  id: "pro",
  name: "Pro",
  maxMonitors: 10,
  minIntervalMinutes: 60,
  allowFullMode: true,
};

export const PLANS: Record<PlanId, Plan> = { free: FREE_PLAN, pro: PRO_PLAN };

/** Public view of a plan: safe to return in API responses. */
export function publicPlan(plan: Plan): Plan {
  return { ...plan };
}

/**
 * Resolve a plan for an email address. Pro when the (lowercased,
 * trimmed) address appears in PRO_EMAILS; Free otherwise, including
 * when the env var is unset. Read at call time so tests can mutate
 * process.env without a reload.
 */
export function planForEmail(email: string): Plan {
  const list = (process.env.PRO_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase()) ? PRO_PLAN : FREE_PLAN;
}

/** Absolute clamp for a requested interval: 60–10080 minutes. */
export function clampIntervalMinutes(raw: unknown): number {
  const n = typeof raw === "number" ? Math.floor(raw) : 1440;
  if (!Number.isFinite(n)) return 1440;
  return Math.min(10080, Math.max(60, n));
}

/**
 * Apply a plan's interval floor on top of the absolute clamp: a Free
 * monitor asking for hourly checks gets daily instead, with the route
 * noting the adjustment. Never clamps below the plan floor.
 */
export function clampIntervalForPlan(plan: Plan, raw: unknown): number {
  return Math.max(plan.minIntervalMinutes, clampIntervalMinutes(raw));
}

export type CreateCheck =
  | { allowed: true }
  | {
      allowed: false;
      /** Machine-readable reason for the client upgrade prompt. */
      code: "limit" | "mode" | "duplicate";
      reason: string;
    };

/**
 * Pure creation gate: duplicate URL for the same email, monitor count
 * against the plan cap, and full-mode on a plan that forbids it.
 * `existingCount` counts the caller's ACTIVE monitors; `duplicate`
 * is true when they already actively monitor this exact URL.
 */
export function checkCreateAllowed(
  plan: Plan,
  opts: { existingCount: number; duplicate: boolean; mode: ScanMode },
): CreateCheck {
  if (opts.duplicate) {
    return {
      allowed: false,
      code: "duplicate",
      reason: "you already monitor this URL — use the existing monitor",
    };
  }
  if (opts.existingCount >= plan.maxMonitors) {
    return {
      allowed: false,
      code: "limit",
      reason:
        plan.id === "free"
          ? `Free plan allows ${plan.maxMonitors} monitor — upgrade to Pro for ${PRO_PLAN.maxMonitors}`
          : `Pro plan allows ${plan.maxMonitors} monitors`,
    };
  }
  if (opts.mode === "full" && !plan.allowFullMode) {
    return {
      allowed: false,
      code: "mode",
      reason: "full-mode monitoring requires Pro — Free monitors run passive scans",
    };
  }
  return { allowed: true };
}
