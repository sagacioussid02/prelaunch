/** Background scan job: persists live progress, then the final (or failed) result. */

import { initialProgress, runScan } from "./scanner.ts";
import { getScan, saveScan } from "./store.ts";
import type { ScanMode, ScanResult } from "./checks/types.ts";

/** Saves a "running" placeholder, then returns `done`, which resolves once the scan is stored. */
export async function startScanJob(
  url: string,
  mode: ScanMode,
  id: string,
): Promise<{ done: Promise<ScanResult | null> }> {
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
    progress: initialProgress(mode),
  };
  await saveScan(placeholder);

  // Chained so a late progress write can never overwrite the final result.
  let chain: Promise<void> = Promise.resolve();
  const onProgress = (p: ScanResult["progress"]) => {
    const snap: ScanResult = { ...placeholder, progress: p?.map((x) => ({ ...x })) };
    chain = chain.then(() => saveScan(snap)).catch(() => {});
  };

  const done = runScan(url, mode, id, onProgress)
    .then(async (result) => {
      await chain;
      await saveScan(result);
      return result;
    })
    .catch(async (err) => {
      await chain;
      const failed = await getScan(id);
      if (failed) {
        failed.status = "failed";
        failed.error = String((err as Error)?.message ?? err).slice(0, 300);
        failed.finishedAt = new Date().toISOString();
        await saveScan(failed);
      }
      console.error("scan failed", id, err);
      return null;
    });
  return { done };
}
