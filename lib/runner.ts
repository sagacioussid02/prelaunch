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
  listStoredMonitors,
  runMonitor,
  clampIntervalMinutes,
} from "./monitor.ts";

/** The monitor fields due-selection reads — structural, for unit tests. */
export interface DueView {
  enabled?: boolean;
  domainVerified?: boolean;
  nextRunAt?: string | null;
}

/** Pure due check, unit-tested: never-scheduled verified monitors are due. */
export function isMonitorDue(m: DueView, nowMs: number): boolean {
  if (m.enabled === false) return false;
  if (!m.domainVerified) return false;
  if (!m.nextRunAt) return true;
  return Date.parse(m.nextRunAt) <= nowMs;
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
): Promise<RunnerSummary> {
  const nowMs = now.getTime();
  const monitors = await listStoredMonitors();
  const candidates = monitors.filter((m) => m.enabled !== false && !!m.domainVerified);
  const summary: RunnerSummary = {
    checkedAt: now.toISOString(),
    candidates: candidates.length,
    started: 0,
    skippedNotDue: 0,
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
