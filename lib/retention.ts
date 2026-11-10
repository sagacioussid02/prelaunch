/**
 * Retention (issue #3, Phase 1). Called daily by /api/cron/retention.
 *
 * - Anonymous scan reports older than SCAN_RETENTION_DAYS are deleted with
 *   their screenshots (lib/store.ts deleteExpiredScans).
 * - Monitor history is kept: every scan a monitor's run history or
 *   baseline points at is protected, whatever its age. Monitor records
 *   themselves are never touched here. With DATABASE_URL set they live in
 *   Postgres, so baselines and history survive redeploys.
 */

import { deleteExpiredScans } from "./store.ts";
import { listStoredMonitors } from "./monitor.ts";

export const SCAN_RETENTION_DAYS = 30;

export interface RetentionSummary {
  ranAt: string;
  retentionDays: number;
  /** Scans kept because a monitor's history or baseline references them. */
  protectedScans: number;
  deletedScans: number;
}

/** Scan ids referenced by any monitor (run history + baseline). */
export async function monitorScanIds(): Promise<Set<string>> {
  const keep = new Set<string>();
  for (const m of await listStoredMonitors()) {
    for (const run of m.runs ?? []) if (run?.scanId) keep.add(run.scanId);
    if (m.baselineScanId) keep.add(m.baselineScanId);
  }
  return keep;
}

export async function runRetention(
  retentionDays = SCAN_RETENTION_DAYS,
  now = new Date(),
): Promise<RetentionSummary> {
  const keep = await monitorScanIds();
  const deletedScans = await deleteExpiredScans(retentionDays, keep);
  return {
    ranAt: now.toISOString(),
    retentionDays,
    protectedScans: keep.size,
    deletedScans,
  };
}
