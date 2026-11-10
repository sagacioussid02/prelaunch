/**
 * Durable background work checks (issue #4, Phase 1).
 *
 * Covers:
 * - expireIfStale / getScanChecked: a scan left "running" past 5 minutes
 *   (its function was frozen) reads back as failed with a readable reason,
 *   and that is persisted.
 * - startScanJob deadline: a scan that overruns its deadline ends "failed"
 *   with the deadline reason, and the late result never overwrites it.
 * - 10 scans in a row against a local fixture all reach done or failed;
 *   none stays running (the local analog of the issue's preview test).
 * - Monitors: isRunStale, the public view hides a frozen `running` flag,
 *   the runner sweep clears it, and a run whose recording throws still
 *   clears `running` (runMonitor's `done` never rejects).
 * - keepAlive() outside a request scope does not throw.
 *
 * Self-contained: file store in a temp dir, loopback fixtures allowed.
 * Run: node scripts/test-background-jobs.ts
 */
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerAliasHooks } from "./node-alias-hooks.ts";

process.env.PRELAUNCH_DATA_DIR = mkdtempSync(join(tmpdir(), "pl-jobs-"));
await registerAliasHooks(process.env.PRELAUNCH_DATA_DIR);
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

const { startScanJob, DEADLINE_REASON } = await import("../lib/jobs.ts");
const { expireIfStale, getScanChecked, STALE_REASON, STALE_SCAN_MS } = await import("../lib/scanstatus.ts");
const { getScan, saveScan, newScanId } = await import("../lib/store.ts");
const {
  createMonitor,
  getMonitor,
  getStoredMonitor,
  updateStoredMonitor,
  isRunStale,
  runMonitor,
  MONITOR_STALE_RUN_MS,
} = await import("../lib/monitor.ts");
const { runDueMonitors } = await import("../lib/runner.ts");
const { keepAlive } = await import("../lib/background.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- pure stale expiry ---
{
  const now = Date.now();
  const base = {
    id: "x",
    url: "https://example.test",
    mode: "passive" as const,
    status: "running" as const,
    score: 0,
    grade: "?",
    findings: [],
    checkTimings: {},
  };
  const fresh = { ...base, startedAt: new Date(now - 60_000).toISOString() };
  const old = { ...base, startedAt: new Date(now - STALE_SCAN_MS - 1000).toISOString() };
  check("stale: a 1-minute-old running scan is left alone", expireIfStale(fresh, now) === null);
  const expired = expireIfStale(old, now);
  check("stale: a >5-minute running scan becomes failed", expired?.status === "failed" && expired.error === STALE_REASON && !!expired.finishedAt);
  check("stale: a done scan is never expired", expireIfStale({ ...old, status: "done" }, now) === null);
  check("stale: a failed scan is never re-expired", expireIfStale({ ...old, status: "failed" }, now) === null);
}

// --- getScanChecked persists the expiry ---
{
  const id = newScanId();
  await saveScan({
    id,
    url: "https://example.test",
    mode: "passive",
    status: "running",
    startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    score: 0,
    grade: "?",
    findings: [],
    checkTimings: {},
  });
  const read = await getScanChecked(id);
  const stored = await getScan(id);
  check("getScanChecked: frozen scan reads as failed", read?.status === "failed" && read.error === STALE_REASON);
  check("getScanChecked: failure persisted for other readers", stored?.status === "failed");
  check("getScanChecked: unknown id is null", (await getScanChecked(newScanId())) === null);
}

// --- fixtures ---
const okServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><head><title>Fixture</title></head><body><h1>fixture</h1></body></html>");
});
// Answers slowly, so a scan against it outlives a short deadline but still ends.
const slowServer = createServer((_req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Slow</title></head><body>slow</body></html>");
  }, 3000);
});
for (const s of [okServer, slowServer]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
const portOf = (s: typeof okServer) => {
  const a = s.address();
  if (!a || typeof a === "string") throw new Error("no port");
  return a.port;
};
const okUrl = `http://127.0.0.1:${portOf(okServer)}`;
const slowUrl = `http://127.0.0.1:${portOf(slowServer)}`;

try {
  // --- deadline ---
  {
    const id = newScanId();
    const job = await startScanJob(slowUrl, "passive", id, { deadlineMs: 500 });
    const res = await job.done;
    const after = await getScan(id);
    check("deadline: done resolves null", res === null);
    check("deadline: scan stored as failed with the readable reason", after?.status === "failed" && after.error === DEADLINE_REASON, JSON.stringify(after?.error));
    // Let the real scan finish behind the deadline; it must not flip the report back.
    await sleep(17_000); // past CHECK_TIMEOUT_MS, so the real scan has ended
    const later = await getScan(id);
    check("deadline: late result does not overwrite the failure", later?.status === "failed" && later.error === DEADLINE_REASON, later?.status);
  }

  // --- 10 scans in a row reach a final state ---
  {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = newScanId();
      ids.push(id);
      const job = await startScanJob(i % 3 === 2 ? "http://127.0.0.1:1" : okUrl, "passive", id);
      await job.done;
    }
    const states = await Promise.all(ids.map(async (id) => (await getScanChecked(id))?.status));
    check("10 scans: all done or failed, none running", states.every((s) => s === "done" || s === "failed"), JSON.stringify(states));
    check("10 scans: fixture scans are done", states.filter((s) => s === "done").length >= 7, JSON.stringify(states));
  }

  // --- monitor stale flag ---
  {
    const now = Date.now();
    check("isRunStale: idle monitor is not stale", !isRunStale({ running: false, lastRunAt: new Date(now - 10 * 60_000).toISOString() }, now));
    check("isRunStale: fresh run is not stale", !isRunStale({ running: true, lastRunAt: new Date(now - 60_000).toISOString() }, now));
    check("isRunStale: run past the window is stale", isRunStale({ running: true, lastRunAt: new Date(now - MONITOR_STALE_RUN_MS - 1).toISOString() }, now));
    check("isRunStale: running with no lastRunAt is stale", isRunStale({ running: true }, now));

    const m = await createMonitor(okUrl);
    const stored = await getStoredMonitor(m.id);
    if (!stored) throw new Error("monitor missing");
    stored.running = true;
    stored.lastRunAt = new Date(now - 10 * 60_000).toISOString();
    await updateStoredMonitor(stored);
    check("public view: frozen run is not shown as running", (await getMonitor(m.id))?.running === false);
    const summary = await runDueMonitors("http://runner.test");
    check("runner sweep: stale running flag cleared in storage", summary.clearedStale >= 1 && (await getStoredMonitor(m.id))?.running === false, JSON.stringify(summary));
  }

  // --- a run whose recording throws still clears `running` ---
  {
    const m = await createMonitor(okUrl);
    const stored = await getStoredMonitor(m.id);
    if (!stored) throw new Error("monitor missing");
    // Corrupt record: the completion path reads runs.length and throws.
    (stored as unknown as { runs: unknown }).runs = null;
    await updateStoredMonitor(stored);
    const r = await runMonitor(m.id, "manual", "http://runner.test");
    check("broken record: run starts", r.ok);
    if (r.ok) {
      let rejected = false;
      await r.done.catch(() => {
        rejected = true;
      });
      check("broken record: done never rejects", !rejected);
      check("broken record: running cleared after a failed recording", (await getStoredMonitor(m.id))?.running === false);
    }
  }

  // --- a monitor run against a dead target clears running and resolves done ---
  {
    const m = await createMonitor("http://127.0.0.1:1");
    const r = await runMonitor(m.id, "manual", "http://runner.test");
    if (r.ok) await r.done;
    check("dead target: run resolves and running clears", r.ok && (await getStoredMonitor(m.id))?.running === false);
  }

  // --- keepAlive outside a request scope ---
  {
    let threw = false;
    let ran = false;
    try {
      keepAlive(Promise.resolve().then(() => { ran = true; }));
      keepAlive(Promise.reject(new Error("expected test rejection")));
    } catch {
      threw = true;
    }
    await sleep(50);
    check("keepAlive: no request scope, no throw, work still runs", !threw && ran);
  }
} finally {
  okServer.close();
  slowServer.close();
}

if (failures) {
  console.log(`${failures} FAILED (test-background-jobs)`);
  process.exit(1);
}
console.log("ALL PASS (test-background-jobs)");
process.exit(0);
