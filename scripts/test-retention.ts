/**
 * Retention checks (issue #3, Phase 1).
 *
 * File-store backend (no Postgres on this machine; the SQL path is
 * compile-verified and must be proven on a preview with Neon):
 * - an anonymous scan older than 30 days is deleted with its screenshot;
 * - a scan just as old that a monitor's history or baseline points at is
 *   kept, with its screenshot, and the monitor record is untouched;
 * - a recent anonymous scan is kept;
 * - /api/cron/retention refuses calls without CRON_SECRET (403) and runs
 *   with it (200 + summary).
 *
 * Postgres backend: when PRELAUNCH_TEST_DATABASE_URL points at a throwaway
 * database, the same protect/delete cases also run against Postgres
 * (scans backdated with SQL). Skipped otherwise.
 *
 * Run: node scripts/test-retention.ts
 *      PRELAUNCH_TEST_DATABASE_URL=postgres://… node scripts/test-retention.ts
 */
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAliasHooks } from "./node-alias-hooks.ts";

const dataDir = mkdtempSync(join(tmpdir(), "pl-retention-"));
process.env.PRELAUNCH_DATA_DIR = dataDir;
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;
process.env.CRON_SECRET = "test-cron-secret";
await registerAliasHooks(dataDir);

const { saveScan, saveShot, getScan, getShot, newScanId } = await import("../lib/store.ts");
const { createMonitor, getStoredMonitor, updateStoredMonitor } = await import("../lib/monitor.ts");
const { runRetention, monitorScanIds } = await import("../lib/retention.ts");
const { dbQuery } = await import("../lib/db.ts");
const { NextRequest } = await import("next/server");
const { GET } = await import("../app/api/cron/retention/route.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

async function makeScan(ageDays: number): Promise<string> {
  const id = newScanId();
  const at = new Date(Date.now() - ageDays * 86_400_000);
  await saveScan({
    id,
    url: "https://example.test",
    mode: "passive",
    status: "done",
    startedAt: at.toISOString(),
    score: 90,
    grade: "A",
    findings: [],
    checkTimings: {},
  });
  await saveShot(id, "desktop", Buffer.from("jpeg"));
  // The file store ages scans by mtime; backdate both files.
  await fs.utimes(join(dataDir, `${id}.json`), at, at);
  await fs.utimes(join(dataDir, "shots", `${id}-desktop.jpg`), at, at);
  return id;
}

const oldAnon = await makeScan(45);
const oldHistory = await makeScan(45);
const oldBaseline = await makeScan(45);
const recentAnon = await makeScan(2);

const m = await createMonitor("http://127.0.0.1:1");
const stored = await getStoredMonitor(m.id);
if (!stored) throw new Error("monitor missing");
stored.baselineScanId = oldBaseline;
stored.runs = [
  {
    scanId: oldHistory,
    at: new Date(Date.now() - 45 * 86_400_000).toISOString(),
    trigger: "baseline",
    score: 90,
    grade: "A",
    blockers: 0,
    warnings: 0,
    newBlockers: [],
    alertSent: false,
  },
];
await updateStoredMonitor(stored);

const keep = await monitorScanIds();
check("monitorScanIds: history and baseline scans protected", keep.has(oldHistory) && keep.has(oldBaseline) && keep.size === 2);

const summary = await runRetention();
check("retention: one scan deleted", summary.deletedScans === 1, JSON.stringify(summary));
check("retention: old anonymous scan gone", (await getScan(oldAnon)) === null);
check("retention: its screenshot gone", (await getShot(oldAnon, "desktop")) === null);
check("retention: monitor history scan kept", (await getScan(oldHistory)) !== null && (await getShot(oldHistory, "desktop")) !== null);
check("retention: monitor baseline scan kept", (await getScan(oldBaseline)) !== null && (await getShot(oldBaseline, "desktop")) !== null);
check("retention: recent anonymous scan kept", (await getScan(recentAnon)) !== null);
const after = await getStoredMonitor(m.id);
check("retention: monitor record untouched", after?.runs.length === 1 && after.baselineScanId === oldBaseline);

const call = (auth?: string) =>
  GET(new NextRequest("http://localhost/api/cron/retention", auth ? { headers: { authorization: auth } } : {}));
check("cron route: no secret → 403", (await call()).status === 403);
check("cron route: wrong secret → 403", (await call("Bearer nope")).status === 403);
const ok = await call("Bearer test-cron-secret");
const body = (await ok.json()) as { retentionDays?: number; deletedScans?: number };
check("cron route: right secret → 200 with summary", ok.status === 200 && body.retentionDays === 30 && body.deletedScans === 0, JSON.stringify(body));

// ---- Postgres backend (optional) ----
if (process.env.PRELAUNCH_TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.PRELAUNCH_TEST_DATABASE_URL;
  const pgScan = async (ageDays: number): Promise<string> => {
    const id = newScanId();
    await saveScan({
      id,
      url: "https://example.test",
      mode: "passive",
      status: "done",
      startedAt: new Date().toISOString(),
      score: 90,
      grade: "A",
      findings: [],
      checkTimings: {},
    });
    await dbQuery(`UPDATE scans SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [id, ageDays]);
    return id;
  };
  const pgOld = await pgScan(45);
  const pgHistory = await pgScan(45);
  const pgRecent = await pgScan(2);
  const pm = await createMonitor("http://127.0.0.1:1");
  const ps = await getStoredMonitor(pm.id);
  if (!ps) throw new Error("pg monitor missing");
  ps.baselineScanId = pgHistory;
  await updateStoredMonitor(ps);
  const pgSummary = await runRetention();
  check("postgres: old anonymous scan deleted", (await getScan(pgOld)) === null, JSON.stringify(pgSummary));
  check("postgres: monitor-referenced old scan kept", (await getScan(pgHistory)) !== null);
  check("postgres: recent scan kept", (await getScan(pgRecent)) !== null);
  check("postgres: monitor survives", (await getStoredMonitor(pm.id))?.baselineScanId === pgHistory);
  // An empty keep-set must not disable deletion (id = ANY('{}') is false).
  const { deleteExpiredScans } = await import("../lib/store.ts");
  const pgOld2 = await pgScan(45);
  await deleteExpiredScans(30, new Set());
  check("postgres: empty keep-set still deletes", (await getScan(pgOld2)) === null);
  check("postgres: …but only expired scans", (await getScan(pgRecent)) !== null);
} else {
  console.log("SKIP postgres retention cases (PRELAUNCH_TEST_DATABASE_URL unset)");
}

if (failures) {
  console.log(`${failures} FAILED (test-retention)`);
  process.exit(1);
}
console.log("ALL PASS (test-retention)");
process.exit(0);
