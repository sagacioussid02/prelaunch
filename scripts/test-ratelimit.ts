/**
 * Direct checks for lib/ratelimit.ts (Phase 0 step 2, issue #6).
 *
 * Run: node scripts/test-ratelimit.ts
 *
 * Covers:
 * - In-memory backend (no Upstash env): limit enforcement, per-key
 *   isolation, retryAfterSeconds, clientIp() parsing.
 * - Redis backend against a local fake Upstash REST server (child
 *   process): limit enforcement via server-side counters, TTL armed on
 *   the first hit of a window.
 * - Redis backend unreachable (child process): fail-closed — the check
 *   returns allowed=false instead of throwing or allowing.
 *
 * The Redis cases run in child processes because lib/ratelimit.ts reads
 * its env configuration at import time. No live Upstash is needed.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

const mode = process.argv[2];

if (mode === "redis-ok") {
  // Fake Upstash REST server: POST /incr/{key}, POST /expire/{key}/{sec}.
  const counters = new Map<string, number>();
  const expiries: Array<{ key: string; seconds: number }> = [];
  const server = createServer((req, res) => {
    const parts = (req.url ?? "").split("/").filter(Boolean);
    res.setHeader("content-type", "application/json");
    if (parts[0] === "incr" && parts[1]) {
      const key = decodeURIComponent(parts[1]);
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      res.end(JSON.stringify({ result: n }));
      return;
    }
    if (parts[0] === "expire" && parts[1] && parts[2]) {
      expiries.push({ key: decodeURIComponent(parts[1]), seconds: Number(parts[2]) });
      res.end(JSON.stringify({ result: 1 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "unknown command" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${addr.port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

  const { checkLimit } = await import("../lib/ratelimit.ts");
  const a = await checkLimit("scan:203.0.113.1", 2, 3600);
  const b = await checkLimit("scan:203.0.113.1", 2, 3600);
  const c = await checkLimit("scan:203.0.113.1", 2, 3600);
  assert(a.allowed && b.allowed, "redis: first two checks within limit 2 allowed");
  assert(!c.allowed, "redis: third check over limit 2 rejected");
  assert(c.retryAfterSeconds === 3600, "redis: rejection carries the window as retryAfterSeconds");
  assert(
    expiries.length === 1 && expiries[0]?.seconds === 3600,
    "redis: TTL armed exactly once, on the first hit of the window",
  );
  server.close();
  process.exit(0);
}

if (mode === "redis-error") {
  // Nothing listens on port 1: every Redis call fails.
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  const { checkLimit } = await import("../lib/ratelimit.ts");
  const r = await checkLimit("scan:203.0.113.2", 5, 3600);
  assert(!r.allowed, "redis-error: unreachable Redis fails closed (allowed=false)");
  assert(r.retryAfterSeconds === 3600, "redis-error: rejection carries retryAfterSeconds");
  process.exit(0);
}

// ---- Parent: in-memory backend + child processes ----

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const { checkLimit, clientIp } = await import("../lib/ratelimit.ts");

for (let i = 0; i < 5; i++) {
  const r = await checkLimit("scan:198.51.100.7", 5, 3600);
  assert(r.allowed, `memory: scan check ${i + 1} of 5 allowed`);
}
const blocked = await checkLimit("scan:198.51.100.7", 5, 3600);
assert(!blocked.allowed, "memory: 6th scan check over limit 5 rejected");
assert(
  typeof blocked.retryAfterSeconds === "number" &&
    blocked.retryAfterSeconds >= 1 &&
    blocked.retryAfterSeconds <= 3600,
  "memory: rejection carries retryAfterSeconds within the window",
);
const otherKey = await checkLimit("scan:198.51.100.8", 5, 3600);
assert(otherKey.allowed, "memory: a different key is unaffected");

for (let i = 0; i < 10; i++) {
  await checkLimit("monitor:198.51.100.7", 10, 3600);
}
const monitorBlocked = await checkLimit("monitor:198.51.100.7", 10, 3600);
assert(!monitorBlocked.allowed, "memory: 11th monitor check over limit 10 rejected");

assert(
  clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })) === "203.0.113.9",
  "clientIp: first x-forwarded-for hop wins",
);
assert(
  clientIp(new Headers({ "x-real-ip": "203.0.113.10" })) === "203.0.113.10",
  "clientIp: x-real-ip fallback",
);
assert(clientIp(new Headers()) === "unknown", "clientIp: no headers -> unknown");

const self = fileURLToPath(import.meta.url);
for (const childMode of ["redis-ok", "redis-error"]) {
  const child = spawnSync(process.execPath, [self, childMode], {
    stdio: "inherit",
    env: { ...process.env },
  });
  assert(child.status === 0, `child mode ${childMode} passed`);
}

console.log("test-ratelimit: ALL PASS");
