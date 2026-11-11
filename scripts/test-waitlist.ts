/**
 * Direct checks for the waitlist port (Phase 0 step 3).
 *
 * Run: node scripts/test-waitlist.ts
 *
 * Covers the fallback (JSON file) backend — DATABASE_URL and the Upstash
 * variables are unset for the whole run:
 * - lib/waitlist.ts: normalizeEmail accept/reject, saveWaitlistEmail
 *   create + dedupe, hasWaitlistEmail, rows persisted to waitlist.json.
 * - app/api/waitlist/route.ts POST, exercised through the real handler:
 *   201 created, 200 already-registered, 400 invalid email, 400 invalid
 *   source, 429 after 10 signups/hour from one IP (shared in-memory
 *   limiter from lib/ratelimit.ts).
 *
 * The route module is imported through a tiny module hook that maps the
 * repo's "@/..." import alias to the repo root — Next resolves that alias
 * at build time; plain node does not. The hook also resolves
 * "next/server" to its server.js entry for the same reason.
 *
 * The Postgres backend is NOT exercised: no Postgres exists on this
 * machine, so that path is compile-verified only (see the step-3 PR).
 */
import { promises as fs } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

// Isolate all state before importing the modules under test: fresh data
// dir, no Postgres, no Redis (lib/waitlist.ts reads PRELAUNCH_DATA_DIR at
// import time; lib/ratelimit.ts reads the Upstash vars at import time).
const dataDir = await fs.mkdtemp(join(tmpdir(), "prelaunch-waitlist-test-"));
process.env.PRELAUNCH_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

// "@/..." alias hook. Customization hooks run in a worker thread and need
// a real file, so write it into the temp dir with the repo root baked in.
// The hook also maps "next/server" to its server.js entry: Next's package
// exports don't resolve that subpath under plain node ESM.
const rootUrl = new URL("../", import.meta.url).href;
const hooksFile = join(dataDir, "alias-hooks.mjs");
await fs.writeFile(
  hooksFile,
  `
import { existsSync } from "node:fs";
const ROOT = ${JSON.stringify(rootUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return { url: ROOT + "node_modules/next/server.js", shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    for (const suffix of [".ts", ".tsx", ".js", ".mjs"]) {
      const url = ROOT + rel + suffix;
      if (existsSync(new URL(url))) return { url, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
`,
);
register(pathToFileURL(hooksFile));

// ---- Storage (lib/waitlist.ts, JSON fallback backend) ----

const { normalizeEmail, hasWaitlistEmail, saveWaitlistEmail, listWaitlist } =
  await import("../lib/waitlist.ts");

assert(
  normalizeEmail("  User@Example.COM ") === "user@example.com",
  "normalizeEmail: trims and lowercases",
);
assert(normalizeEmail("not-an-email") === null, "normalizeEmail: rejects missing @");
assert(normalizeEmail("a@b") === null, "normalizeEmail: rejects dotless domain");
assert(normalizeEmail("") === null, "normalizeEmail: rejects empty string");
assert(normalizeEmail(42) === null, "normalizeEmail: rejects non-string");
assert(normalizeEmail(undefined) === null, "normalizeEmail: rejects undefined");

assert((await hasWaitlistEmail("store1@example.com")) === false, "hasWaitlistEmail: false before signup");

const first = await saveWaitlistEmail({ email: "store1@example.com", source: "landing" });
assert(first.created === true && first.total === 1, "saveWaitlistEmail: first signup created, total 1");

assert((await hasWaitlistEmail("store1@example.com")) === true, "hasWaitlistEmail: true after signup");

const dupe = await saveWaitlistEmail({ email: "store1@example.com", source: "landing" });
assert(dupe.created === false && dupe.total === 1, "saveWaitlistEmail: duplicate deduped, total still 1");

const second = await saveWaitlistEmail({
  email: "store2@example.com",
  source: "report",
  url: "https://example.com",
});
assert(second.created === true && second.total === 2, "saveWaitlistEmail: report signup created, total 2");

const entries = await listWaitlist();
assert(entries.length === 2, "listWaitlist: two entries");
assert(
  entries[1]?.source === "report" && entries[1]?.url === "https://example.com",
  "listWaitlist: report source + scanned url preserved",
);

const onDisk = JSON.parse(await fs.readFile(join(dataDir, "waitlist.json"), "utf8")) as unknown[];
assert(Array.isArray(onDisk) && onDisk.length === 2, "fallback backend: waitlist.json persisted with 2 rows");

// ---- Route (app/api/waitlist/route.ts, real POST handler) ----

const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/waitlist/route.ts");

function post(body: unknown, ip: string): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

const created = await post({ email: "Route1@Example.com", source: "landing" }, "203.0.113.20");
assert(created.status === 201, "route: new signup -> 201");
const createdBody = (await created.json()) as { ok?: boolean; already?: boolean };
assert(createdBody.ok === true && createdBody.already === false, "route: 201 body { ok, already: false }");

const again = await post({ email: "route1@example.com" }, "203.0.113.21");
assert(again.status === 200, "route: duplicate signup -> 200");
const againBody = (await again.json()) as { ok?: boolean; already?: boolean };
assert(againBody.ok === true && againBody.already === true, "route: 200 body { ok, already: true }");

const badEmail = await post({ email: "nope" }, "203.0.113.22");
assert(badEmail.status === 400, "route: invalid email -> 400");

const badSource = await post({ email: "ok2@example.com", source: "junk" }, "203.0.113.23");
assert(badSource.status === 400, "route: invalid source -> 400");

for (let i = 0; i < 10; i++) {
  const r = await post({ email: `rl${i}@example.com` }, "203.0.113.30");
  assert(r.status === 201, `route: signup ${i + 1} of 10 from one IP allowed`);
}
const limited = await post({ email: "rl10@example.com" }, "203.0.113.30");
assert(limited.status === 429, "route: 11th signup from one IP in an hour -> 429");
assert(
  Number(limited.headers.get("retry-after")) >= 1,
  "route: 429 carries a Retry-After header",
);
assert(
  (await hasWaitlistEmail("rl10@example.com")) === false,
  "route: rate-limited signup was not stored",
);

await fs.rm(dataDir, { recursive: true, force: true });
console.log("test-waitlist: ALL PASS");
