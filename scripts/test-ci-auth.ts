/**
 * GitHub Action server side: Prelaunch keys, GitHub OIDC verification,
 * the tier decision, and POST /api/ci/scan end to end.
 *
 * - Keys: format, only the hash is stored, lookup, revoke.
 * - OIDC: a locally generated RSA key stands in for GitHub's JWKS. Valid
 *   public-repo token passes; wrong audience/issuer, expired, not-yet-valid,
 *   over-long lifetime, bad signature, unknown kid, alg none/HS256 and
 *   missing claims are refused.
 * - Tiers: Pro key → paid; key whose email isn't Pro → 402; revoked or
 *   unknown key → 401; public-repo OIDC → free; private/internal → 402;
 *   nothing → 401.
 * - Route: 401/402 never start a scan; an accepted CI scan runs passive
 *   against a loopback fixture and its result is readable from the same
 *   endpoints the Action polls; per-credential hourly limit → 429; the
 *   per-host cap still applies to CI scans; the website's /api/scan limits
 *   are untouched (6th website scan from one IP is still 429).
 *
 * Self-contained: temp PRELAUNCH_DATA_DIR, JSON store, in-memory limiter.
 * Run: node scripts/test-ci-auth.ts
 */
import { generateKeyPairSync, createSign } from "node:crypto";
import { promises as fs, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAliasHooks } from "./node-alias-hooks.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dataDir = mkdtempSync(join(tmpdir(), "pl-ci-auth-"));
process.env.PRELAUNCH_DATA_DIR = dataDir;
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
process.env.PRELAUNCH_IP_HASH_SALT = "test-salt";
process.env.PRO_EMAILS = "pro@example.com";
process.env.PRELAUNCH_CI_SCANS_PER_HOUR_FREE = "2";
for (const k of [
  "DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL", "KV_REST_API_TOKEN", "STRIPE_SECRET_KEY", "PRELAUNCH_CI_SCANS_PER_HOUR_PAID",
]) delete process.env[k];
await registerAliasHooks(dataDir);

const cikeys = await import("../lib/cikeys.ts");
const oidc = await import("../lib/github-oidc.ts");
const { authorizeCiRequest } = await import("../lib/ciauth.ts");

// ---------- keys ----------
const { key: proKey, record: proRec } = await cikeys.issueCiKey(" Pro@Example.com ", "ci");
const { key: freeKey } = await cikeys.issueCiKey("free@example.com");
const { key: revokedKey, record: revokedRec } = await cikeys.issueCiKey("pro@example.com", "old");
check("key: format plk_ + 43 base64url", /^plk_[A-Za-z0-9_-]{43}$/.test(proKey), proKey.length.toString());
check("key: email normalised", proRec.email === "pro@example.com");
const stored = await fs.readFile(join(dataDir, "ci-keys.json"), "utf8");
check("key: raw key never stored, only its hash", !stored.includes(proKey) && stored.includes(cikeys.hashCiKey(proKey)));
check("key: lookup finds it", (await cikeys.findActiveCiKey(proKey))?.id === proRec.id);
check("key: revoke", (await cikeys.revokeCiKey(revokedRec.id)) && (await cikeys.findActiveCiKey(revokedKey)) === null);
check("key: revoke unknown id → false", !(await cikeys.revokeCiKey("ck_nope")));
check("key: malformed / unknown → null", (await cikeys.findActiveCiKey("plk_short")) === null && (await cikeys.findActiveCiKey(cikeys.generateCiKey())) === null);
let threw = false;
try { await cikeys.issueCiKey("not-an-email"); } catch { threw = true; }
check("key: invalid email refused", threw);

// ---------- OIDC ----------
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: KID, kty: "RSA", alg: "RS256", use: "sig" };
let jwksFetches = 0;
const fetchJwks = async () => {
  jwksFetches++;
  return { keys: [jwk] };
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function makeToken(claims: Record<string, unknown>, header: Record<string, unknown> = {}, signer = privateKey): string {
  const h = b64({ alg: "RS256", typ: "JWT", kid: KID, ...header });
  const p = b64(claims);
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(signer).toString("base64url");
  return `${h}.${p}.${sig}`;
}
const now = Math.floor(Date.now() / 1000);
const baseClaims = {
  iss: oidc.GITHUB_OIDC_ISSUER,
  aud: "prelaunch",
  iat: now,
  nbf: now,
  exp: now + 300,
  repository: "octo/public-app",
  repository_id: "111",
  repository_visibility: "public",
};
const v = (t: string) => oidc.verifyGithubOidcToken(t, { fetchJwks });
const ok = await v(makeToken(baseClaims));
check("oidc: valid public token accepted", ok.ok && ok.claims.repository === "octo/public-app", JSON.stringify(ok));
const cases: [string, string, string][] = [
  ["wrong audience", makeToken({ ...baseClaims, aud: "sts.amazonaws.com" }), "wrong audience"],
  ["wrong issuer", makeToken({ ...baseClaims, iss: "https://evil.example" }), "wrong issuer"],
  ["expired", makeToken({ ...baseClaims, exp: now - 600, iat: now - 900, nbf: now - 900 }), "expired"],
  ["not yet valid", makeToken({ ...baseClaims, nbf: now + 600, iat: now + 600, exp: now + 900 }), "not yet valid"],
  ["lifetime > 1h", makeToken({ ...baseClaims, exp: now + 7200 }), "lifetime too long"],
  ["signed by another key", makeToken(baseClaims, {}, other.privateKey), "bad signature"],
  ["tampered payload", (() => { const [h, , s] = makeToken(baseClaims).split("."); return `${h}.${b64({ ...baseClaims, repository_visibility: "public", repository: "octo/x" })}.${s}`; })(), "bad signature"],
  ["unknown kid", makeToken(baseClaims, { kid: "other" }), "unknown signing key"],
  ["alg none", `${b64({ alg: "none", kid: KID })}.${b64(baseClaims)}.e30`, "unsupported alg"],
  ["alg HS256", makeToken(baseClaims, { alg: "HS256" }), "unsupported alg"],
  ["missing visibility", makeToken({ ...baseClaims, repository_visibility: undefined }), "missing repository_visibility claim"],
  ["garbage", "not.a-jwt", "malformed token"],
];
for (const [name, token, reason] of cases) {
  const r = await v(token);
  check(`oidc: ${name} refused`, !r.ok && r.reason === reason, JSON.stringify(r));
}
const before = jwksFetches;
await v(makeToken(baseClaims));
check("oidc: JWKS cached between calls", jwksFetches === before);

// ---------- tiers ----------
const bearer = (t: string) => `Bearer ${t}`;
const a1 = await authorizeCiRequest(bearer(proKey), { fetchJwks });
check("tier: Pro key → paid", a1.ok && a1.tier === "paid" && a1.limitKey === `ci:key:${proRec.id}`, JSON.stringify(a1));
const a2 = await authorizeCiRequest(bearer(freeKey), { fetchJwks });
check("tier: key whose email isn't Pro → 402", !a2.ok && a2.status === 402, JSON.stringify(a2));
const a3 = await authorizeCiRequest(bearer(revokedKey), { fetchJwks });
check("tier: revoked key → 401", !a3.ok && a3.status === 401);
const a4 = await authorizeCiRequest(bearer(makeToken(baseClaims)), { fetchJwks });
check("tier: public-repo OIDC → free, limited per repo id", a4.ok && a4.tier === "free" && a4.limitKey === "ci:repo:111", JSON.stringify(a4));
const a5 = await authorizeCiRequest(bearer(makeToken({ ...baseClaims, repository_visibility: "private" })), { fetchJwks });
check("tier: private-repo OIDC → 402 pointing at keys", !a5.ok && a5.status === 402 && /Prelaunch key/.test(a5.reason));
const a6 = await authorizeCiRequest(bearer(makeToken({ ...baseClaims, repository_visibility: "internal" })), { fetchJwks });
check("tier: internal-repo OIDC → 402", !a6.ok && a6.status === 402);
const a7 = await authorizeCiRequest(null);
check("tier: no credentials → 401", !a7.ok && a7.status === 401);
const a8 = await authorizeCiRequest("Bearer something-else");
check("tier: unrecognised credentials → 401", !a8.ok && a8.status === 401);

// ---------- route ----------
const fixture = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><head><title>Preview</title></head><body>ok</body></html>");
});
await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
const addr = fixture.address();
if (!addr || typeof addr === "string") throw new Error("no fixture port");
const fixtureUrl = `http://127.0.0.1:${addr.port}`;

const logs: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.includes('"event":"scan_request"')) logs.push(line);
  else origLog(...args);
};

try {
  const { NextRequest } = await import("next/server");
  const { POST: ciPOST } = await import("../app/api/ci/scan/route.ts");
  const { POST: webPOST } = await import("../app/api/scan/route.ts");
  const { GET: statusGET } = await import("../app/api/scan/[id]/route.ts");
  const { GET: reportGET } = await import("../app/api/report/[id]/route.ts");
  const { getScan } = await import("../lib/store.ts");

  const waitDone = async (id: string) => {
    for (let i = 0; i < 900; i++) {
      const s = await getScan(id);
      if (s && s.status !== "running") return s;
      await sleep(100);
    }
    return null;
  };
  const ci = async (auth: string | null, body: unknown, ip = "198.51.100.7") => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
    if (auth) headers.authorization = auth;
    const res = await ciPOST(new NextRequest("http://localhost/api/ci/scan", { method: "POST", headers, body: JSON.stringify(body) }));
    const text = await res.text();
    let json: Record<string, string> | null = null;
    try { json = JSON.parse(text); } catch { /* text body */ }
    if (json?.id) await waitDone(json.id);
    return { status: res.status, text, json };
  };

  const r401 = await ci(null, { url: fixtureUrl });
  check("route: no credentials → 401", r401.status === 401, r401.text);
  const r402 = await ci(bearer(makeToken({ ...baseClaims, repository_visibility: "private" })), { url: fixtureUrl });
  check("route: private repo without key → 402", r402.status === 402, r402.text);
  check("route: refusals logged without starting a scan",
    logs.filter((l) => /"outcome":"(unauthorized|payment_required)"/.test(l)).length === 2 &&
    !logs.some((l) => /"outcome":"accepted"/.test(l)));

  // Paid key: accepted, passive, result readable through the Action's endpoints.
  const paid = await ci(bearer(proKey), { url: fixtureUrl, mode: "full" });
  check("route: Pro key accepted", paid.status === 200 && paid.json?.tier === "paid", paid.text);
  const id = paid.json?.id ?? "";
  check("route: returns the polling paths", paid.json?.statusUrl === `/api/scan/${id}` && paid.json?.resultUrl === `/api/report/${id}?format=json` && paid.json?.reportUrl === `/r/${id}`);
  const stat = await statusGET(new Request(`http://localhost/api/scan/${id}`), { params: Promise.resolve({ id }) });
  const statJson = (await stat.json()) as { status: string };
  check("route: status endpoint shows the finished scan", stat.status === 200 && statJson.status === "done", JSON.stringify(statJson));
  const rep = await reportGET(new Request(`http://localhost/api/report/${id}?format=json`), { params: Promise.resolve({ id }) });
  const repJson = (await rep.json()) as { mode: string; grade: string; findings: unknown[] };
  check("route: CI scans are passive even if full is asked for", repJson.mode === "passive", repJson.mode);
  check("route: result has grade and findings", typeof repJson.grade === "string" && Array.isArray(repJson.findings));

  const bad = await ci(bearer(proKey), { url: "" });
  check("route: missing url → 400", bad.status === 400);

  // Free tier: per-repository limit (set to 2 for the test), then 429.
  const pubToken = bearer(makeToken({ ...baseClaims, repository: "octo/limited", repository_id: "222" }));
  const f1 = await ci(pubToken, { url: fixtureUrl }, "198.51.100.8");
  const f2 = await ci(pubToken, { url: fixtureUrl }, "198.51.100.9");
  const f3 = await ci(pubToken, { url: fixtureUrl }, "198.51.100.10");
  check("route: free tier accepted for a public repo", f1.status === 200 && f1.json?.tier === "free", f1.text);
  check("route: free tier limited per repository across IPs", f2.status === 200 && f3.status === 429 && /per repository/.test(f3.text), `${f2.status} ${f3.status} ${f3.text}`);
  const other = await ci(bearer(makeToken({ ...baseClaims, repository: "octo/other", repository_id: "333" })), { url: fixtureUrl });
  check("route: another repository has its own allowance", other.status === 200, other.text);

  // Per-host cap (10/hour across everything) still applies to CI scans:
  // 5 scans of the fixture so far (paid, 2 free, other, below) → fill the rest with the paid key.
  let hostStatus = 0;
  let accepted = 4;
  for (let i = 0; i < 8 && hostStatus !== 429; i++) {
    const r = await ci(bearer(proKey), { url: fixtureUrl }, `198.51.100.${20 + i}`);
    hostStatus = r.status;
    if (r.status === 200) accepted++;
  }
  check("route: per-host cap still applies to CI scans (11th scan of one host → 429)", hostStatus === 429 && accepted === 10, `${hostStatus} accepted=${accepted}`);

  // Website limits unchanged: 5 scans/hour/IP, 6th is 429 (different host so the host cap doesn't interfere).
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await webPOST(new NextRequest("http://localhost/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.99" },
      body: JSON.stringify({ url: `http://localhost:${addr.port}` }),
    }));
    statuses.push(res.status);
    const j = (await res.json().catch(() => null)) as { id?: string } | null;
    if (j?.id) await waitDone(j.id);
  }
  check("route: website per-IP limit unchanged", JSON.stringify(statuses) === "[200,200,200,200,200,429]", JSON.stringify(statuses));
  check("route: log never contains a key", !logs.some((l) => l.includes(proKey)));
} finally {
  console.log = origLog;
  fixture.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
