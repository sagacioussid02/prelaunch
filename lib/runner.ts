/**
 * Scheduled runner (Phase 0 step 4, adapted from the local prototype's
 * lib/runner.ts; triggered by /api/cron/run-monitors).
 *
 * It considers every enabled, domain-verified monitor and starts a
 * check for each one whose nextRunAt has passed — or that has never
 * been scheduled, in which case the first check sets the baseline.
 * runMonitor advances nextRunAt when the check completes.
 *
 * Why verified-only: an unverified monitor's site control was never
 * proven; auto-running it on a schedule would let anyone who created a
 * monitor burn scan quota against someone else's site indefinitely.
 * Verification is the proof the schedule is wanted. Unverified monitors
 * still run via their deploy hook and the dashboard's manual run.
 * Disabled monitors are skipped entirely.
 *
 * Adaptation from the prototype: repo checks are background jobs
 * (lib/jobs.ts), so the runner STARTS checks and reports them as
 * "started" with their scan id — diffing, alerting and email happen in
 * runMonitor's completion path, exactly as for deploy-triggered runs.
 * A monitor can therefore never be notified by the runner unless it is
 * verified: unverified monitors are never started.
 *
 * Failures are per-monitor, never fatal to the run: one monitor's
 * problem must not skip the rest. The returned summary is the audit
 * trail for the run.
 */

import {
  isRunStale,
  listStoredMonitors,
  runMonitor,
  updateStoredMonitor,
  clampIntervalMinutes,
} from "./monitor.ts";

/** The monitor fields due-selection reads — structural, for unit tests. */
export interface DueView {
  enabled?: boolean;
  domainVerified?: boolean;
  nextRunAt?: string | null;
  intervalMinutes?: number;
}

/**
 * Longest early-run allowance. Kept under the hourly trigger's spacing:
 * a grace of an hour or more would let a daily monitor run on the trigger
 * an hour before its slot, then an hour earlier the next day, and so on.
 */
export const MAX_DUE_GRACE_MS = 45 * 60_000;

/**
 * How early a monitor may run. The triggers are coarse and drift: GitHub
 * Actions' hourly schedule often fires minutes late, and a Hobby daily cron
 * lands anywhere in its hour. nextRunAt is set from the previous run's
 * time, so without slack a trigger that lands a little earlier than the
 * last one skips the monitor and its cadence doubles (hourly becomes every
 * 2 hours). 30% of the interval, capped at MAX_DUE_GRACE_MS. Runs still
 * happen only on triggers, so this snaps them to the trigger slot instead
 * of drifting earlier.
 */
export function dueGraceMs(intervalMinutes: number | undefined): number {
  return Math.min(MAX_DUE_GRACE_MS, clampIntervalMinutes(intervalMinutes ?? 1440) * 60_000 * 0.3);
}

/** Pure due check, unit-tested: never-scheduled verified monitors are due. */
export function isMonitorDue(m: DueView, nowMs: number): boolean {
  if (m.enabled === false) return false;
  if (!m.domainVerified) return false;
  if (!m.nextRunAt) return true;
  return Date.parse(m.nextRunAt) - dueGraceMs(m.intervalMinutes) <= nowMs;
}

export function computeNextRun(fromIso: string, intervalMinutes: number): string {
  return new Date(Date.parse(fromIso) + intervalMinutes * 60_000).toISOString();
}

export interface RunnerSummary {
  checkedAt: string;
  /** Enabled + verified monitors considered. */
  candidates: number;
  /** Checks actually started. */
  started: number;
  /** Candidates skipped because they were not due yet. */
  skippedNotDue: number;
  /** Monitors whose stale `running` flag was cleared this run (issue #4). */
  clearedStale: number;
  results: Array<{
    monitorId: string;
    url: string;
    status: "started" | "skipped" | "failed";
    scanId?: string;
    reason?: string;
    error?: string;
  }>;
}

export async function runDueMonitors(
  baseUrl: string,
  now = new Date(),
  /**
   * Receives each started run's completion promise so the cron route can
   * keep the invocation alive until they are recorded (issue #4).
   */
  track?: (done: Promise<void>) => void,
): Promise<RunnerSummary> {
  const nowMs = now.getTime();
  const monitors = await listStoredMonitors();
  // Sweep: a monitor whose function was frozen mid-run keeps `running: true`
  // in storage. Clear it here so the dashboard and triggers see it as idle.
  let clearedStale = 0;
  for (const m of monitors) {
    if (!isRunStale(m, nowMs)) continue;
    try {
      m.running = false;
      await updateStoredMonitor(m);
      clearedStale++;
    } catch (err) {
      console.error("runner: could not clear stale running flag", m.id, err);
    }
  }
  const candidates = monitors.filter((m) => m.enabled !== false && !!m.domainVerified);
  const summary: RunnerSummary = {
    checkedAt: now.toISOString(),
    candidates: candidates.length,
    started: 0,
    skippedNotDue: 0,
    clearedStale,
    results: [],
  };
  for (const monitor of candidates) {
    if (!isMonitorDue(monitor, nowMs)) {
      summary.skippedNotDue++;
      summary.results.push({ monitorId: monitor.id, url: monitor.url, status: "skipped", reason: "not due" });
      continue;
    }
    try {
      const r = await runMonitor(monitor.id, "scheduled", baseUrl);
      if (r.ok) {
        track?.(r.done);
        summary.started++;
        summary.results.push({ monitorId: monitor.id, url: monitor.url, status: "started", scanId: r.scanId });
      } else if (r.reason === "cooldown" || r.reason === "busy") {
        summary.results.push({ monitorId: monitor.id, url: monitor.url, status: "skipped", reason: r.reason });
      } else {
        summary.results.push({ monitorId: monitor.id, url: monitor.url, status: "failed", reason: r.reason });
      }
    } catch (err) {
      summary.results.push({
        monitorId: monitor.id,
        url: monitor.url,
        status: "failed",
        error: String((err as Error).message ?? err).slice(0, 300),
      });
    }
  }
  return summary;
}

export { clampIntervalMinutes };
