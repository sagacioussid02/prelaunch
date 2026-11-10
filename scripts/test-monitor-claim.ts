/**
 * Monitoring v2 domain-verification checks (Phase 0 step 4):
 * claim → publish → verify round-trip against a local fixture serving
 * a mutable /.well-known/prelaunch-check.txt, including the tamper
 * cases — wrong body stays unverified, and re-claiming rotates the
 * token so the previously published token no longer verifies.
 *
 * Self-contained: isolates PRELAUNCH_DATA_DIR to a temp dir and permits
 * loopback fixtures before importing the lib modules.
 * Run: node scripts/test-monitor-claim.ts
 */
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRELAUNCH_DATA_DIR = mkdtempSync(join(tmpdir(), "pl-claim-"));
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

const {
  createMonitor,
  getMonitor,
  requestVerificationClaim,
  verifyDomainOwnership,
} = await import("../lib/monitor.ts");
const { VERIFICATION_PATH } = await import("../lib/ownership.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// The fixture serves whatever `publishedBody` currently holds at the
// well-known path — the test "publishes" by assigning to it.
let publishedBody = "";
const server = createServer((req, res) => {
  if (req.url === VERIFICATION_PATH) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(publishedBody);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><head><title>Fixture</title></head><body>fixture</body></html>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("fixture server has no port");
const fixtureUrl = `http://127.0.0.1:${addr.port}`;

try {
  const m = await createMonitor(fixtureUrl);

  // Verify before any claim: a reason, not a crash, still unverified.
  {
    const r = await verifyDomainOwnership(m.id);
    check("verify before claim: refused with reason", !r.verified && r.reason.includes("claim"));
    check("verify before claim: still unverified", (await getMonitor(m.id))?.domainVerified === false);
  }

  // Claim issues a token and the publish target URL.
  const claim1 = await requestVerificationClaim(m.id);
  check("claim: token + path + url", claim1.token.length >= 32 && claim1.path === VERIFICATION_PATH && claim1.url === `${fixtureUrl}${VERIFICATION_PATH}`);

  // Wrong body published → mismatch, stays unverified.
  publishedBody = "some-other-token";
  {
    const r = await verifyDomainOwnership(m.id);
    check("verify: wrong body rejected", !r.verified && r.reason.includes("does not match"));
    check("verify: wrong body leaves monitor unverified", (await getMonitor(m.id))?.domainVerified === false);
  }

  // Correct token published (with trailing newline, as a real file
  // would have) → verified, and the public view shows it.
  publishedBody = `${claim1.token}\n`;
  {
    const r = await verifyDomainOwnership(m.id);
    check("verify: published token verifies", r.verified && r.reason === "verified", r.reason);
    check("verify: public view shows verified", (await getMonitor(m.id))?.domainVerified === true);
  }

  // Tamper: re-claim rotates the token; the old published body must
  // no longer verify a fresh monitor, and the new token must.
  const m2 = await createMonitor(fixtureUrl);
  const claimA = await requestVerificationClaim(m2.id);
  const claimB = await requestVerificationClaim(m2.id);
  check("claim: re-claim rotates the token", claimA.token !== claimB.token);
  publishedBody = claimA.token;
  {
    const r = await verifyDomainOwnership(m2.id);
    check("verify: superseded token rejected", !r.verified);
  }
  publishedBody = claimB.token;
  {
    const r = await verifyDomainOwnership(m2.id);
    check("verify: current token accepted", r.verified);
  }

  // Unknown monitor: claim/verify throw the not-found error routes map to 404.
  {
    let claimThrew = false;
    try {
      await requestVerificationClaim("00000000-0000-0000-0000-000000000000");
    } catch (err) {
      claimThrew = String((err as Error).message).includes("not found");
    }
    check("claim: unknown monitor throws not found", claimThrew);
  }
} finally {
  server.close();
}

if (failures > 0) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log("ALL PASS (test-monitor-claim)");
