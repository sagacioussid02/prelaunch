/**
 * Pay-per-call API (RapidAPI): POST /api/v1/check end to end.
 *
 * - Gateway auth: RAPIDAPI_PROXY_SECRET unset → 503 for every call; missing
 *   or wrong X-RapidAPI-Proxy-Secret → 401 and no check runs.
 * - Plans: header parsing, unknown plan → BASIC limits.
 * - Checks: a deliberately leaky fixture gets the exposed .env blocker, the
 *   sourcemap warning and the missing-header findings; a clean fixture
 *   passes the .env and sourcemap checks; response shape and grade.
 * - Input: missing/invalid url → 400; private, metadata and loopback-only
 *   targets → 400 (SSRF guard); a site that doesn't answer → 422.
 * - Limits: per-user hourly cap by plan → 429 with Retry-After while other
 *   users are unaffected; the shared per-target-host cap still applies; the
 *   API's global cap is separate from the website's.
 * - Logs: never contain the gateway secret or the RapidAPI username.
 *
 * Self-contained: temp PRELAUNCH_DATA_DIR, in-memory limiter, loopback fixtures.
 * Run: node scripts/test-api-check.ts
 */
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
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

const SECRET = "test-proxy-secret-0123456789";
const dataDir = mkdtempSync(join(tmpdir(), "pl-api-check-"));
process.env.PRELAUNCH_DATA_DIR = dataDir;
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
process.env.PRELAUNCH_IP_HASH_SALT = "test-salt";
for (const k of [
  "DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL", "KV_REST_API_TOKEN", "RAPIDAPI_PROXY_SECRET", "PRELAUNCH_API_CALLS_PER_HOUR",
]) delete process.env[k];
await registerAliasHooks(dataDir);

const rapid = await import("../lib/rapidapi.ts");
const quick = await import("../lib/quickcheck.ts");

// ---------- plans + gateway auth (unit) ----------
check("plan: PRO parsed", rapid.parsePlan("pro") === "PRO");
check("plan: unknown → BASIC", rapid.parsePlan("GOLD") === "BASIC" && rapid.parsePlan(null) === "BASIC");
check("plan: caps grow with plan",
  rapid.apiCallsPerHour("BASIC") < rapid.apiCallsPerHour("PRO") &&
  rapid.apiCallsPerHour("PRO") < rapid.apiCallsPerHour("ULTRA") &&
  rapid.apiCallsPerHour("ULTRA") <= rapid.apiCallsPerHour("MEGA"));
const h = (o: Record<string, string>) => new Headers(o);
const u1 = rapid.authorizeRapidApiRequest(h({ "x-rapidapi-proxy-secret": SECRET }));
check("auth: secret env unset → 503 even with a header", !u1.ok && u1.status === 503);
process.env.RAPIDAPI_PROXY_SECRET = SECRET;
const u2 = rapid.authorizeRapidApiRequest(h({}));
check("auth: no header → 401", !u2.ok && u2.status === 401);
const u3 = rapid.authorizeRapidApiRequest(h({ "x-rapidapi-proxy-secret": SECRET + "x" }));
check("auth: wrong secret (different length) → 401", !u3.ok && u3.status === 401);
const u4 = rapid.authorizeRapidApiRequest(h({ "x-rapidapi-proxy-secret": SECRET.replace(/.$/, "X") }));
check("auth: wrong secret (same length) → 401", !u4.ok && u4.status === 401);
const u5 = rapid.authorizeRapidApiRequest(h({
  "x-rapidapi-proxy-secret": SECRET, "x-rapidapi-user": "Alice", "x-rapidapi-subscription": "ULTRA",
}));
check("auth: right secret → ok with user + plan", u5.ok && u5.user === "Alice" && u5.plan === "ULTRA");
check("auth: limiter key hashes the username", u5.ok && !u5.limitKey.toLowerCase().includes("alice"));
const u6 = rapid.authorizeRapidApiRequest(h({ "x-rapidapi-proxy-secret": SECRET, "x-rapidapi-user": "alice" }));
check("auth: username case doesn't split the limit", u5.ok && u6.ok && u5.limitKey === u6.limitKey);

check("checks: exactly the 3 chosen, all passive",
  quick.quickChecks().map((c) => c.id).join(",") === "exposed-env,sourcemap-leak,security-headers" &&
  quick.quickChecks().every((c) => c.modes.includes("passive")));

// ---------- fixtures ----------
function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const a = server.address();
      if (!a || typeof a === "string") throw new Error("no port");
      resolve(a.port);
    });
  });
}
const leaky = createServer((req, res) => {
  if (req.url === "/.env") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("DATABASE_URL=postgres://x\nSTRIPE_SECRET_KEY=sk_test_x\n");
  }
  if (req.url === "/app.js.map") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ version: 3, sources: ["app.ts"], sourcesContent: ["const secret = 1;"] }));
  }
  if (req.url === "/app.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    return res.end("console.log(1)");
  }
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end('<html><head><title>Leaky</title><script src="/app.js"></script></head><body>hi</body></html>');
  }
  res.writeHead(404);
  res.end("not found");
});
const SAFE_HEADERS = {
  "Content-Type": "text/html",
  "Content-Security-Policy": "default-src 'self'",
  "Strict-Transport-Security": "max-age=63072000",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=()",
};
const clean = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, SAFE_HEADERS);
    return res.end('<html><head><title>Clean</title><script src="/app.js"></script></head><body>ok</body></html>');
  }
  res.writeHead(404, SAFE_HEADERS);
  res.end("not found");
});
const leakyUrl = `http://127.0.0.1:${await listen(leaky, "127.0.0.1")}`;
// "localhost" so the clean fixture has its own per-host counter.
const cleanUrl = `http://localhost:${await listen(clean, "127.0.0.1")}`;
const deadServer = createServer();
const deadPort = await listen(deadServer, "127.0.0.1");
await new Promise<void>((r) => deadServer.close(() => r()));
const deadUrl = `http://127.0.0.1:${deadPort}`;

const logs: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.includes('"event":"scan_request"')) logs.push(line);
  else origLog(...args);
};
const origError = console.error;
console.error = () => {}; // expected noise from the fixtures

try {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/v1/check/route.ts");
  let ipN = 0;
  const call = async (
    body: unknown,
    opts: { secret?: string | null; user?: string; plan?: string } = {},
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${++ipN % 250}`,
    };
    const secret = opts.secret === undefined ? SECRET : opts.secret;
    if (secret) headers["x-rapidapi-proxy-secret"] = secret;
    headers["x-rapidapi-user"] = opts.user ?? "alice";
    if (opts.plan) headers["x-rapidapi-subscription"] = opts.plan;
    const res = await POST(new NextRequest("http://localhost/api/v1/check", {
      method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
    }));
    const json = (await res.json()) as Record<string, any>;
    return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
  };

  // Route-level auth
  delete process.env.RAPIDAPI_PROXY_SECRET;
  const off = await call({ url: leakyUrl });
  check("route: secret env unset → 503 JSON", off.status === 503 && typeof off.json.error === "string");
  process.env.RAPIDAPI_PROXY_SECRET = SECRET;
  const noSecret = await call({ url: leakyUrl }, { secret: null });
  check("route: no gateway secret → 401 JSON", noSecret.status === 401 && noSecret.json.status === 401);
  const badSecret = await call({ url: leakyUrl }, { secret: "nope" });
  check("route: wrong gateway secret → 401", badSecret.status === 401);

  // Leaky site (host 127.0.0.1: 1)
  const r = await call({ url: leakyUrl });
  check("leaky: 200", r.status === 200, JSON.stringify(r.json));
  const f = (r.json.findings ?? []) as Array<{ checkId: string; severity: string; title: string }>;
  check("leaky: exposed .env is a blocker", f.some((x) => x.checkId === "exposed-env" && x.severity === "blocker" && x.title.includes("/.env")));
  check("leaky: sourcemap is a warning", f.some((x) => x.checkId === "sourcemap-leak" && x.severity === "warning"));
  check("leaky: missing CSP reported", f.some((x) => x.checkId === "security-headers" && /Content-Security-Policy/.test(x.title)));
  check("leaky: findings sorted blockers first", f.length > 0 && f[0].severity === "blocker");
  check("leaky: not ready, failing grade", r.json.ready === false && r.json.grade === "F" && r.json.score < 60);
  check("leaky: summary counts match", r.json.summary.blockers + r.json.summary.warnings + r.json.summary.info === f.length);
  check("leaky: 3 checks reported, each with an outcome",
    r.json.checks.length === 3 && r.json.checks.every((c: any) => c.outcome === "issues"));
  check("leaky: url normalised, timing present", r.json.url === leakyUrl && typeof r.json.durationMs === "number" && !!r.json.checkedAt);

  // Clean site (host localhost: 1)
  const c = await call({ url: cleanUrl });
  check("clean: 200", c.status === 200, JSON.stringify(c.json));
  const cf = (c.json.findings ?? []) as Array<{ checkId: string; title: string }>;
  const byId = Object.fromEntries((c.json.checks ?? []).map((x: any) => [x.id, x.outcome]));
  check("clean: .env and sourcemap checks pass", byId["exposed-env"] === "passed" && byId["sourcemap-leak"] === "passed");
  check("clean: no missing-header findings", !cf.some((x) => /^Missing /.test(x.title)));

  // Input errors (no host quota used)
  check("input: missing url → 400", (await call({})).status === 400);
  check("input: not JSON → 400", (await call("not json")).status === 400);
  check("input: bad url → 400", (await call({ url: "http://" })).status === 400);
  check("input: private address → 400", (await call({ url: "http://10.0.0.5" })).status === 400);
  check("input: cloud metadata → 400", (await call({ url: "http://169.254.169.254/latest/meta-data" })).status === 400);
  check("input: non-http scheme → 400", (await call({ url: "ftp://example.com" })).status === 400);

  // Unreachable (host 127.0.0.1: 2)
  const dead = await call({ url: deadUrl });
  check("unreachable: 422 with a readable reason", dead.status === 422 && /did not respond/.test(dead.json.error), JSON.stringify(dead.json));

  // Per-user cap: BASIC = 20/hour. carol spends 20 on bad bodies, the 21st is 429.
  const basic = rapid.apiCallsPerHour("BASIC");
  for (let i = 0; i < basic; i++) await call({}, { user: "carol" });
  const capped = await call({ url: leakyUrl }, { user: "carol" });
  check("user cap: over the BASIC cap → 429 + Retry-After", capped.status === 429 && Number(capped.retryAfter) > 0 && /BASIC/.test(capped.json.error), JSON.stringify(capped.json));
  check("user cap: another user is unaffected", (await call({}, { user: "dave" })).status === 400);
  const proCarol = await call({}, { user: "carol", plan: "PRO" });
  check("user cap: limit follows the plan header", proCarol.status === 400, String(proCarol.status));

  // Per-host cap: 10/hour per target host, shared with the website. 2 used so far.
  let lastOk = 0;
  for (let i = 0; i < 8; i++) {
    const x = await call({ url: leakyUrl }, { user: `bulk${i}` });
    if (x.status === 200) lastOk++;
  }
  check("host cap: calls up to the cap succeed", lastOk === 8, String(lastOk));
  const hostCapped = await call({ url: leakyUrl }, { user: "erin" });
  check("host cap: 11th check of one site → 429", hostCapped.status === 429 && /this site/.test(hostCapped.json.error));
  const otherHost = await call({ url: cleanUrl }, { user: "erin" });
  check("host cap: a different site still works", otherHost.status === 200);

  // Global API cap: calls past the host cap so far = leaky 1 + clean 1 + dead 1 + bulk 8 + other host 1 = 12.
  process.env.PRELAUNCH_API_CALLS_PER_HOUR = "13";
  check("global cap: under the cap → 200", (await call({ url: cleanUrl }, { user: "frank" })).status === 200);
  const globalCapped = await call({ url: cleanUrl }, { user: "frank" });
  check("global cap: over the cap → 429", globalCapped.status === 429 && /capacity/.test(globalCapped.json.error));
  const { checkLimit } = await import("../lib/ratelimit.ts");
  check("global cap: separate from the website's scan cap", (await checkLimit("scanglobal", 200, 3600)).allowed);
  delete process.env.PRELAUNCH_API_CALLS_PER_HOUR;

  // Logs
  const all = logs.join("\n");
  check("logs: one line per call", logs.length > 40, String(logs.length));
  check("logs: gateway secret never logged", !all.includes(SECRET));
  check("logs: RapidAPI usernames never logged", !/carol|alice|bulk0/.test(all));
  check("logs: outcomes recorded",
    ["unauthorized", "accepted", "invalid", "unreachable", "rate_limited_api", "rate_limited_host", "rate_limited_global"]
      .every((o) => all.includes(`"outcome":"${o}"`)));
  check("logs: plan recorded as mode", all.includes('"mode":"api-basic"') && all.includes('"mode":"api-pro"'));
} finally {
  console.log = origLog;
  console.error = origError;
  leaky.close();
  clean.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nall API check tests passed");
process.exit(failures ? 1 : 0);
