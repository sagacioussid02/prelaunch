/**
 * Keep background work alive after the response (issue #4, Phase 1).
 *
 * On Vercel a function can be frozen once its response is sent, so a scan
 * left as a fire-and-forget promise may never finish. Next's `after()`
 * extends the invocation until the promise settles (bounded by the route's
 * `maxDuration`). Outside a request scope (scripts, unit tests) `after()`
 * throws; there the promise simply keeps running in the Node process,
 * which is the old behaviour and fine for a long-lived process.
 *
 * This is the first step from the release plan. If scans outgrow one
 * invocation, the next step is a real queue (Vercel Queues/Workflow) with
 * explicit retries and the concurrency cap moved into the queue.
 */

import { after } from "next/server";

export function keepAlive(work: Promise<unknown>): void {
  const settled = work.catch((err) => {
    console.error("background work failed", err);
  });
  try {
    after(settled);
  } catch {
    // No request scope (script or test): the promise keeps running anyway.
    void settled;
  }
}
