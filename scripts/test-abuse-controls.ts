/**
 * Abuse controls (issue #6, Phase 1), through the real route handlers.
 *
 * The issue's three acceptance tests, locally:
 * 1. Cross-instance limits: two separate node processes (two "instances")
 *    share one fake Upstash REST server; the per-IP limit holds across
 *    them, so the 6th scan from one IP gets 429 whichever process serves it.
 * 2. Per-host cap: 10 scans of one host from 10 different IPs succeed, the
 *    11th (from yet another IP) gets 429; a different host is unaffected.
 *    Then the global cap: with PRELAUNCH_GLOBAL_SCANS_PER_HOUR lowered, the
 *    next scan of any host gets 429.
 * 3. Manual monitor run: `?manual=1` with no token / a wrong token / a
 *    forged, expired or other-monitor grant → 401; the deploy token or a
 *    valid signed grant → 202. Without PRELAUNCH_LINK_SECRET no grant is
 *    minted or accepted.
 * Plus: the scan request log records hashed IPs (never the raw IP), the
 *    host and the outcome; with PRELAUNCH_TEST_DATABASE_URL set the rows
 *    land in Postgres `scan_requests`.
 *
 * Run: node scripts/test-abuse-controls.ts
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const dataDir = mkdtempSync(join(tmpdir(), "pl-abuse-"));
process.env.PRELAUNCH_DATA_DIR = dataDir;
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
process.env.PRELAUNCH_IP_HASH_SALT = "test-salt";
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;
await registerAliasHooks(dataDir);

const mode = process.argv[2];

// ---------- child: one "instance" hitting a shared fake Upstash ----------
if (mode === "instance") {
  // argv: instance <requests> ; env carries UPSTASH_* pointing at the parent's fake.
  const n = Number(process.argv[3]);
  const fixture = process.env.TEST_FIXTURE_URL ?? "";
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/scan/route.ts");
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await POST(
      new NextRequest("http://localhost/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" },
        body: JSON.stringify({ url: fixture }),
      }),
    );
    statuses.push(res.status);
    await sleep(1500); // let the in-process concurrency slot free up
  }
  console.log(`STATUSES ${JSON.stringify(statuses)}`);
  process.exit(0);
}

// ---------- parent ----------
const fixture = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><head><title>Fixture</title></head><body>ok</body></html>");
});
await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
const fAddr = fixture.address();
if (!fAddr || typeof fAddr === "string") throw new Error("no fixture port");
const fixtureUrl = `http://127.0.0.1:${fAddr.port}`;

// Fake Upstash REST: POST /incr/{key}, POST /expire/{key}/{sec}.
const counters = new Map<string, number>();
const upstash = createServer((req, res) => {
  const parts = (req.url ?? "").split("/").filter(Boolean);
  res.setHeader("content-type", "application/json");
  if (parts[0] === "incr" && parts[1]) {
    const key = decodeURIComponent(parts[1]);
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    res.end(JSON.stringify({ result: n }));
    return;
  }
  if (parts[0] === "expire") {
    res.end(JSON.stringify({ result: 1 }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise<void>((r) => upstash.listen(0, "127.0.0.1", r));
const uAddr = upstash.address();
if (!uAddr || typeof uAddr === "string") throw new Error("no upstash port");

const self = fileURLToPath(import.meta.url);

try {
  // ---- 1. cross-instance per-IP limit (async spawn so the fake Redis keeps serving) ----
  {
    // Instance A uses Upstash's own env names; instance B uses the KV_REST_API_*
    // names the Vercel Marketplace integration adds. Both must share one counter.
    const runInstance = (n: number, names: "upstash" | "kv") =>
      new Promise<number[]>((resolve) => {
        const redisEnv =
          names === "upstash"
            ? { UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${uAddr.port}`, UPSTASH_REDIS_REST_TOKEN: "test-token" }
            : { KV_REST_API_URL: `http://127.0.0.1:${uAddr.port}`, KV_REST_API_TOKEN: "test-token" };
        const base = { ...process.env };
        for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete base[k];
        const child = spawn(process.execPath, [self, "instance", String(n)], {
          env: {
            ...base,
            PRELAUNCH_DATA_DIR: mkdtempSync(join(tmpdir(), "pl-abuse-inst-")),
            ...redisEnv,
            TEST_FIXTURE_URL: fixtureUrl,
          },
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.on("close", () => {
          const m = /STATUSES (\[.*\])/.exec(out);
          resolve(m ? (JSON.parse(m[1]) as number[]) : []);
        });
      });
    const a = await runInstance(3, "upstash");
    const b = await runInstance(3, "kv");
    check("cross-instance: instance A's 3 scans accepted", a.length === 3 && a.every((s) => s === 200), JSON.stringify(a));
    check(
      "cross-instance: instance B (KV_REST_API_* names) gets 429 on the 6th scan from the same IP",
      b.length === 3 && b[0] === 200 && b[1] === 200 && b[2] === 429,
      JSON.stringify(b),
    );
    check("cross-instance: counter lives in the shared store", counters.get("scan:203.0.113.50") === 6, String(counters.get("scan:203.0.113.50")));
  }

  // ---- in-process route tests (in-memory limiter) ----
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes('"event":"scan_request"')) logs.push(line);
    else origLog(...args);
  };

  const { NextRequest } = await import("next/server");
  const { POST: scanPOST } = await import("../app/api/scan/route.ts");
  const { POST: deployPOST } = await import("../app/api/monitor/[id]/deploy/route.ts");
  const { POST: monitorPOST } = await import("../app/api/monitor/route.ts");
  const { getScan } = await import("../lib/store.ts");
  const { hashIp } = await import("../lib/scanlog.ts");
  const { mintRunGrant, verifyRunGrant } = await import("../lib/runlink.ts");
  const { SCANS_PER_HOUR_PER_HOST, scanHostKey } = await import("../lib/ratelimit.ts");

  const scan = async (url: string, ip: string) => {
    const res = await scanPOST(
      new NextRequest("http://localhost/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ url }),
      }),
    );
    const text = await res.text();
    let id: string | undefined;
    try {
      id = (JSON.parse(text) as { id?: string }).id;
    } catch {
      /* 429/400 bodies are text */
    }
    // Wait for the scan to finish so the per-instance concurrency cap (2) never interferes.
    if (id) {
      for (let i = 0; i < 100; i++) {
        const s = await getScan(id);
        if (s && s.status !== "running") break;
        await sleep(100);
      }
    }
    return { status: res.status, text, id };
  };

  // ---- 2. per-host cap across different IPs ----
  {
    const statuses: number[] = [];
    for (let i = 0; i < SCANS_PER_HOUR_PER_HOST; i++) statuses.push((await scan(fixtureUrl, `198.51.100.${i + 1}`)).status);
    check(`per-host: ${SCANS_PER_HOUR_PER_HOST} scans of one host from different IPs accepted`, statuses.every((s) => s === 200), JSON.stringify(statuses));
    const over = await scan(fixtureUrl, "198.51.100.99");
    check("per-host: the 11th scan of that host (new IP) gets 429", over.status === 429 && /this site was scanned/.test(over.text), `${over.status} ${over.text}`);
    check(
      "per-host: case, trailing dot and www. map to one host key",
      scanHostKey("WWW.Example.com.") === "example.com" && scanHostKey("example.com") === "example.com" && scanHostKey("app.example.com") === "app.example.com",
    );
    const other = await scan(`http://localhost:${fAddr.port}`, "198.51.100.97");
    check("per-host: a different host is unaffected", other.status === 200, `${other.status} ${other.text}`);
  }

  // ---- global cap ----
  {
    // Global counter so far: 10 (127.0.0.1) + 1 (localhost). Lower the cap to 12.
    process.env.PRELAUNCH_GLOBAL_SCANS_PER_HOUR = "12";
    const ok = await scan(`http://localhost:${fAddr.port}`, "192.0.2.1");
    const over = await scan(`http://localhost:${fAddr.port}`, "192.0.2.2");
    check("global: scans under the cap accepted", ok.status === 200, `${ok.status} ${ok.text}`);
    check("global: the next scan over the cap gets 429", over.status === 429 && /hourly capacity/.test(over.text), `${over.status} ${over.text}`);
    delete process.env.PRELAUNCH_GLOBAL_SCANS_PER_HOUR;
  }

  // ---- scan request log ----
  {
    const parsed = logs.map((l) => JSON.parse(l) as Record<string, string | null>);
    check("log: every scan request logged", parsed.length >= 14, String(parsed.length));
    check("log: raw IPs never appear", !logs.some((l) => /198\.51\.100\.|192\.0\.2\.|203\.0\.113\./.test(l)));
    check("log: IP hashed with the salt", parsed.some((p) => p.ipHash === hashIp("198.51.100.1")) && hashIp("198.51.100.1").length === 16);
    check("log: host and outcome recorded", parsed.some((p) => p.host === "127.0.0.1" && p.outcome === "rate_limited_host") && parsed.some((p) => p.outcome === "rate_limited_global") && parsed.some((p) => p.outcome === "accepted" && !!p.scanId));
    const bad = await scan("http://", "192.0.2.3");
    check("log: invalid url → 400 and logged as invalid", bad.status === 400 && JSON.parse(logs[logs.length - 1]).outcome === "invalid");
  }

  // ---- 3. manual monitor run auth ----
  {
    process.env.PRELAUNCH_LINK_SECRET = "test-link-secret";
    const create = async () => {
      const res = await monitorPOST(
        new NextRequest("http://localhost/api/monitor", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
          body: JSON.stringify({ url: fixtureUrl }),
        }),
      );
      const body = (await res.json()) as { id: string; dashboard: string; deployHook: string };
      return { ...body, token: new URL(body.deployHook).searchParams.get("token") ?? "" };
    };
    const manual = (id: string, opts: { token?: string; grant?: string } = {}) => {
      const qs = new URLSearchParams({ manual: "1" });
      if (opts.grant) qs.set("grant", opts.grant);
      return deployPOST(
        new NextRequest(`http://localhost/api/monitor/${id}/deploy?${qs}`, {
          method: "POST",
          headers: opts.token ? { "x-prelaunch-token": opts.token } : {},
        }),
        { params: Promise.resolve({ id }) },
      );
    };

    const m1 = await create();
    const linkGrant = new URL(m1.dashboard).searchParams.get("grant");
    check("create: dashboard link carries a signed grant", !!linkGrant && verifyRunGrant(m1.id, linkGrant));
    check("manual: no token → 401", (await manual(m1.id)).status === 401);
    check("manual: wrong token → 401", (await manual(m1.id, { token: "nope" })).status === 401);
    check("manual: forged grant → 401", (await manual(m1.id, { grant: `${Math.floor(Date.now() / 1000) + 600}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` })).status === 401);
    const expired = mintRunGrant(m1.id, Date.now() - 2 * 3600_000);
    check("manual: expired grant → 401", (await manual(m1.id, { grant: expired ?? "" })).status === 401);
    const m2 = await create();
    check("manual: another monitor's grant → 401", (await manual(m2.id, { grant: linkGrant ?? "" })).status === 401);
    check("manual: deploy token → 202", (await manual(m1.id, { token: m1.token })).status === 202);
    check("manual: valid signed grant → 202", (await manual(m2.id, { grant: mintRunGrant(m2.id) ?? "" })).status === 202);
    check("deploy hook path unchanged: token still required", (await deployPOST(
      new NextRequest(`http://localhost/api/monitor/${m1.id}/deploy`, { method: "POST" }),
      { params: Promise.resolve({ id: m1.id }) },
    )).status === 401);

    delete process.env.PRELAUNCH_LINK_SECRET;
    const m3 = await create();
    check("no link secret: no grant minted", !new URL(m3.dashboard).searchParams.get("grant") && mintRunGrant(m3.id) === null);
    check("no link secret: a grant made with the old secret is refused", (await manual(m1.id, { grant: linkGrant ?? "" })).status === 401);
    await sleep(3000); // let the two started monitor runs settle
  }

  // ---- optional: Postgres scan_requests rows ----
  if (process.env.PRELAUNCH_TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.PRELAUNCH_TEST_DATABASE_URL;
    const { dbQuery } = await import("../lib/db.ts");
    const { logScanRequest, deleteExpiredScanRequests } = await import("../lib/scanlog.ts");
    const rec = await logScanRequest({ ip: "198.51.100.200", host: "example.test", mode: "passive", outcome: "accepted", scanId: "abc" });
    const rows = await dbQuery<{ ip_hash: string; host: string; outcome: string }>(
      `SELECT ip_hash, host, outcome FROM scan_requests WHERE ip_hash = $1`,
      [rec.ipHash],
    );
    check("postgres: scan request row stored with hashed IP", rows.length >= 1 && rows[0].host === "example.test" && rows[0].ip_hash !== "198.51.100.200");
    await dbQuery(`UPDATE scan_requests SET at = now() - interval '40 days' WHERE ip_hash = $1`, [rec.ipHash]);
    const deleted = await deleteExpiredScanRequests(30);
    check("postgres: log rows older than 30 days deleted by retention", deleted >= 1);
    delete process.env.DATABASE_URL;
  } else {
    origLog("SKIP postgres scan_requests cases (PRELAUNCH_TEST_DATABASE_URL unset)");
  }
  console.log = origLog;
} finally {
  fixture.close();
  upstash.close();
}

if (failures) {
  console.log(`${failures} FAILED (test-abuse-controls)`);
  process.exit(1);
}
console.log("ALL PASS (test-abuse-controls)");
process.exit(0);
