/**
 * Background scan job: persists live progress, then the final (or failed) result.
 *
 * Durability (issue #4, Phase 1):
 * - Routes hand the job's `done` promise to `keepAlive()` (lib/background.ts),
 *   which uses Next's `after()` so the scan keeps running after the response
 *   is sent instead of being frozen with the serverless function.
 * - In-process deadline: a scan still running after SCAN_DEADLINE_MS is
 *   marked `failed` with a readable reason, and any late result or progress
 *   write is ignored, so the report never flips back to "running".
 * - Read-side expiry: if the function was frozen or killed before either
 *   path ran, the placeholder would say "running" forever. Readers go
 *   through getScanChecked() (lib/scanstatus.ts), which marks a scan that
 *   has been "running" longer than STALE_SCAN_MS as failed (and persists
 *   that), so the progress page always stops spinning.
 */

import { runScan, scanProgress } from "./scanner.ts";
import { getScan, saveScan } from "./store.ts";
import type { ScanMode, ScanResult } from "./checks/types.ts";

/**
 * In-process deadline. Kept under the routes' `maxDuration` (300s) and
 * under STALE_SCAN_MS (lib/scanstatus.ts) so the job marks itself failed
 * before the platform stops the function.
 */
export const SCAN_DEADLINE_MS = 4 * 60_000;

export const DEADLINE_REASON =
  "The scan took longer than 4 minutes and was stopped. Try again; if it keeps happening, the site may be slow to respond to automated checks.";

/** Saves a "running" placeholder, then returns `done`, which resolves once the scan is stored. */
export async function startScanJob(
  url: string,
  mode: ScanMode,
  id: string,
  opts: { deadlineMs?: number } = {},
): Promise<{ done: Promise<ScanResult | null> }> {
  const deadlineMs = opts.deadlineMs ?? SCAN_DEADLINE_MS;
  const placeholder: ScanResult = {
    id,
    url,
    mode,
    status: "running",
    startedAt: new Date().toISOString(),
    score: 0,
    grade: "?",
    findings: [],
    checkTimings: {},
    progress: scanProgress(mode),
  };
  await saveScan(placeholder);

  // Once the job has settled (result, error or deadline), later writes are dropped.
  let settled = false;
  // Chained so a late progress write can never overwrite the final result.
  let chain: Promise<void> = Promise.resolve();
  const onProgress = (p: ScanResult["progress"]) => {
    if (settled) return;
    const snap: ScanResult = { ...placeholder, progress: p?.map((x) => ({ ...x })) };
    chain = chain.then(() => (settled ? undefined : saveScan(snap))).catch(() => {});
  };

  const markFailed = async (reason: string): Promise<null> => {
    await chain;
    const failed = (await getScan(id).catch(() => null)) ?? { ...placeholder };
    failed.status = "failed";
    failed.error = reason.slice(0, 300);
    failed.finishedAt = new Date().toISOString();
    await saveScan(failed).catch((err) => console.error("could not persist failed scan", id, err));
    return null;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });

  const scan = runScan(url, mode, id, onProgress).then(
    (result) => ({ ok: true as const, result }),
    (err: unknown) => ({ ok: false as const, err }),
  );

  const done = Promise.race([scan, deadline]).then(async (outcome) => {
    if (timer) clearTimeout(timer);
    settled = true;
    if (outcome === "deadline") {
      console.error("scan deadline exceeded", id);
      return markFailed(DEADLINE_REASON);
    }
    if (!outcome.ok) {
      console.error("scan failed", id, outcome.err);
      return markFailed(String((outcome.err as Error)?.message ?? outcome.err));
    }
    await chain;
    try {
      await saveScan(outcome.result);
      return outcome.result;
    } catch (err) {
      console.error("could not persist scan result", id, err);
      return markFailed("The scan finished but its result could not be saved. Please run it again.");
    }
  });
  return { done };
}
