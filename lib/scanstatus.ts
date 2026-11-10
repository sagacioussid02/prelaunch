/**
 * Read-side scan status (issue #4, Phase 1). Kept separate from lib/jobs.ts
 * so report pages and status routes do not import the scan engine.
 *
 * If a function is frozen or killed mid-scan, neither the scan's result
 * nor its in-process deadline (lib/jobs.ts) ever runs, and the stored
 * placeholder says "running" forever. Every reader goes through
 * getScanChecked(), which turns a scan that has been "running" longer
 * than STALE_SCAN_MS into a failed one with a readable reason, and
 * persists that, so the progress page always stops spinning.
 */

import { getScan, saveScan } from "./store.ts";
import type { ScanResult } from "./checks/types.ts";

/** Any scan still "running" this long after it started is treated as failed. */
export const STALE_SCAN_MS = 5 * 60_000;

export const STALE_REASON =
  "The scan stopped before it finished (it was still running after 5 minutes, usually because the server was interrupted). Please run it again.";

/**
 * Pure: returns a failed copy of `scan` when it has been "running" for
 * longer than `staleMs`, else null. Unit-tested.
 */
export function expireIfStale(
  scan: ScanResult,
  nowMs: number,
  staleMs = STALE_SCAN_MS,
): ScanResult | null {
  if (scan.status !== "running") return null;
  const started = Date.parse(scan.startedAt);
  if (!Number.isFinite(started) || nowMs - started < staleMs) return null;
  return {
    ...scan,
    status: "failed",
    error: STALE_REASON,
    finishedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * getScan for readers (report page, status API, badge, downloads): expires a
 * stale "running" scan to failed, persisting it best-effort.
 */
export async function getScanChecked(id: string, nowMs = Date.now()): Promise<ScanResult | null> {
  const scan = await getScan(id);
  if (!scan) return null;
  const expired = expireIfStale(scan, nowMs);
  if (!expired) return scan;
  await saveScan(expired).catch((err) => console.error("could not persist stale scan", id, err));
  return expired;
}
