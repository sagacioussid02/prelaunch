/**
 * Monitoring deploy-secret checks (Phase 0 step 4): the per-monitor
 * deploy token — issued once at creation, stored only as a SHA-256
 * hash, compared timing-safely by verifyToken (the check the
 * /api/monitor/{id}/deploy route runs) — accepts the real token and
 * rejects everything else. Also covers the ownership helpers the
 * claim/cron paths rely on (secretsEqual, cronSecretValid fail-closed).
 *
 * Self-contained: isolates PRELAUNCH_DATA_DIR to a temp dir before
 * importing the lib modules.
 * Run: node scripts/test-deploy-hooks.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRELAUNCH_DATA_DIR = mkdtempSync(join(tmpdir(), "pl-hooks-"));
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

const { createMonitor, verifyToken, getStoredMonitor } = await import("../lib/monitor.ts");
const { generateSecret, secretsEqual, cronSecretValid } = await import("../lib/ownership.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// A second local target is unnecessary: token checks never fetch the
// URL — createMonitor only validates + stores it. Loopback is still
// permitted above so hostname validation takes the dev path.
const m = await createMonitor("http://127.0.0.1:9");

check("deploy token: issued at creation", typeof m.token === "string" && m.token.length >= 32);
{
  const stored = await getStoredMonitor(m.id);
  check(
    "deploy token: only its hash is stored",
    !!stored && stored.secretHash !== m.token && !JSON.stringify(stored).includes(m.token),
  );
}
check("deploy token: correct token accepted", await verifyToken(m.id, m.token));
check("deploy token: wrong token rejected", !(await verifyToken(m.id, m.token + "x")));
check("deploy token: empty token rejected", !(await verifyToken(m.id, "")));
check("deploy token: null token rejected", !(await verifyToken(m.id, null)));
check("deploy token: another monitor's token rejected", !(await verifyToken(m.id, generateSecret())));
check(
  "deploy token: unknown monitor rejected",
  !(await verifyToken("00000000-0000-0000-0000-000000000000", m.token)),
);

// Ownership secret compare: timing-safe, fail-closed (ported semantics).
{
  const a = generateSecret();
  const b = generateSecret();
  check("secret: unique hex", a !== b && /^[0-9a-f]+$/.test(a) && a.length === 48);
  check(
    "secretsEqual: equal/wrong/null/length",
    secretsEqual(a, a) && !secretsEqual(a, b) && !secretsEqual(null, a) &&
      !secretsEqual(a, null) && !secretsEqual(a, a + "0"),
  );
}

// Cron auth: fails closed when unconfigured; exact bearer match otherwise.
{
  delete process.env.CRON_SECRET;
  check("cron secret: fails closed when unset", !cronSecretValid("anything") && !cronSecretValid(null));
  process.env.CRON_SECRET = "test-cron-secret";
  check(
    "cron secret: exact match only",
    cronSecretValid("test-cron-secret") && !cronSecretValid("test-cron-secre") && !cronSecretValid(null),
  );
  delete process.env.CRON_SECRET;
}

if (failures > 0) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log("ALL PASS (test-deploy-hooks)");
