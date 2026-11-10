/**
 * Monitoring v2 scheduled-runner checks (Phase 0 step 4): pure
 * due-selection (disabled skipped, unverified never scheduled, cadence
 * window) plus an end-to-end run against a local fixture — a verified
 * monitor is started by the runner, completes, records a "scheduled"
 * baseline run, advances nextRunAt, and clears its `running` flag; a
 * verified monitor pointed at a dead target also clears `running`.
 *
 * Self-contained: isolates PRELAUNCH_DATA_DIR to a temp dir and permits
 * loopback fixtures before importing the lib modules.
 * Run: node scripts/test-monitor-runner.ts
 */
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRELAUNCH_DATA_DIR = mkdtempSync(join(tmpdir(), "pl-runner-"));
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

const { isMonitorDue, computeNextRun, runDueMonitors } = await import("../lib/runner.ts");
const {
  createMonitor,
  getMonitor,
  getStoredMonitor,
  updateStoredMonitor,
  clampIntervalMinutes,
} = await import("../lib/monitor.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// --- pure due-selection ---
{
  const now = Date.now();
  const due = { enabled: true, domainVerified: true, nextRunAt: null };
  check("due: never-scheduled verified is due", isMonitorDue(due, now));
  check("due: past nextRunAt is due", isMonitorDue({ ...due, nextRunAt: new Date(now - 1000).toISOString() }, now));
  check("due: future nextRunAt is not due", !isMonitorDue({ ...due, nextRunAt: new Date(now + 3600_000).toISOString() }, now));
  check("due: unverified never runs on schedule", !isMonitorDue({ ...due, domainVerified: false }, now));
  check("due: disabled never runs", !isMonitorDue({ ...due, enabled: false }, now));
  check("nextRun: +1440 min is tomorrow", computeNextRun("2026-11-04T08:00:00.000Z", 1440) === "2026-11-05T08:00:00.000Z");
  check("interval clamp", clampIntervalMinutes(30) === 60 && clampIntervalMinutes(20000) === 10080 && clampIntervalMinutes(1440) === 1440 && clampIntervalMinutes("x") === 1440);
}

// --- fixture + integration ---
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><head><title>Fixture</title></head><body><h1>fixture</h1></body></html>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("fixture server has no port");
const fixtureUrl = `http://127.0.0.1:${addr.port}`;

// A port that is guaranteed closed: bind, read the port, release it.
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const probeAddr = probe.address();
if (!probeAddr || typeof probeAddr === "string") throw new Error("probe server has no port");
const deadPort = probeAddr.port;
await new Promise<void>((resolve) => probe.close(() => resolve()));

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 120_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

try {
  // m1: verified + enabled → the runner must start it.
  const m1 = await createMonitor(fixtureUrl, undefined, { email: "owner@example.com" });
  // m2: unverified → the runner must never touch it.
  const m2 = await createMonitor(fixtureUrl);
  // m3: verified but disabled → skipped entirely.
  const m3 = await createMonitor(fixtureUrl);
  for (const [id, patch] of [
    [m1.id, { domainVerified: true }],
    [m3.id, { domainVerified: true, enabled: false }],
  ] as const) {
    const stored = await getStoredMonitor(id);
    if (!stored) throw new Error("stored monitor missing");
    Object.assign(stored, patch);
    await updateStoredMonitor(stored);
  }

  const s1 = await runDueMonitors("http://runner.test");
  check("runner: only the verified+enabled monitor is a candidate", s1.candidates === 1, JSON.stringify(s1));
  check("runner: due monitor started", s1.started === 1 && s1.results[0]?.monitorId === m1.id && !!s1.results[0]?.scanId);

  const finished = await waitFor("m1 completion", async () => {
    const pub = await getMonitor(m1.id);
    return !!pub && !pub.running && pub.runs.length === 1;
  });
  check("runner: check completes and running flag clears", finished);
  {
    const pub = await getMonitor(m1.id);
    const stored = await getStoredMonitor(m1.id);
    // Repo semantics: the first recorded run is labeled "baseline"
    // whatever started it; later runs keep their trigger.
    check("runner: first run recorded as baseline", pub?.runs[0]?.trigger === "baseline");
    check("runner: baseline recorded in the durable record", !!stored?.baselineScanId && stored.baselineScanId === pub?.runs[0]?.scanId && typeof stored?.baselineScore === "number");
    check("runner: nextRunAt advanced into the future", !!stored?.nextRunAt && Date.parse(stored.nextRunAt) > Date.now());
  }
  {
    // Backdate the cadence + cooldown so a second run is due now, and
    // confirm it keeps the "scheduled" trigger.
    const stored = await getStoredMonitor(m1.id);
    if (!stored) throw new Error("stored monitor missing");
    stored.nextRunAt = new Date(Date.now() - 1000).toISOString();
    stored.lastRunAt = new Date(Date.now() - 120_000).toISOString();
    await updateStoredMonitor(stored);
    const s = await runDueMonitors("http://runner.test");
    check("runner: second due run started", s.started === 1, JSON.stringify(s));
    const done2 = await waitFor("m1 second completion", async () => {
      const pub = await getMonitor(m1.id);
      return !!pub && !pub.running && pub.runs.length === 2;
    });
    const pub = await getMonitor(m1.id);
    check("runner: later run recorded as scheduled", done2 && pub?.runs[1]?.trigger === "scheduled");
  }
  {
    const pub2 = await getMonitor(m2.id);
    check("runner: unverified monitor untouched (no runs, never started)", pub2?.runs.length === 0 && !pub2?.running);
  }

  const s2 = await runDueMonitors("http://runner.test");
  check("runner: not-yet-due monitor skipped", s2.candidates === 1 && s2.started === 0 && s2.skippedNotDue === 1, JSON.stringify(s2));

  // m4: verified, pointed at a dead target → run starts, flag must clear.
  const m4 = await createMonitor(`http://127.0.0.1:${deadPort}`);
  {
    const stored = await getStoredMonitor(m4.id);
    if (!stored) throw new Error("stored monitor missing");
    stored.domainVerified = true;
    await updateStoredMonitor(stored);
  }
  const s3 = await runDueMonitors("http://runner.test");
  check("runner: dead-target monitor started", s3.results.some((r) => r.monitorId === m4.id && r.status === "started"), JSON.stringify(s3));
  const cleared = await waitFor("m4 running flag clears", async () => {
    const pub = await getMonitor(m4.id);
    return !!pub && !pub.running;
  });
  check("runner: running flag clears after a failed/dead-target run", cleared);
} finally {
  server.close();
}

if (failures > 0) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log("ALL PASS (test-monitor-runner)");
