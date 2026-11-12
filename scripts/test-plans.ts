/**
 * Plan-limit checks (Phase 0 step 5): the prototype's test-plans
 * suite ported to the repo's monitor model, plus store-level
 * integration for the pieces the route composes, plus the real
 * POST /api/monitor handler exercised end to end.
 *
 * Repo adaptations vs the prototype suite:
 * - "Active" for counting = enabled !== false (the prototype's
 *   Monitor.active flag has no direct field here; a disabled monitor
 *   consumes no plan slot and does not trigger the duplicate guard).
 * - Monitors have no mode field (repo monitor runs are passive), so
 *   the mode gate is verified at the pure gate AND through the route
 *   (a `mode: "full"` creation request on Free → 402 code "mode").
 * - The route is imported through the same "@/" alias module hook
 *   test-waitlist.ts established (Next resolves the alias at build
 *   time; plain node does not).
 *
 * Self-contained: isolates PRELAUNCH_DATA_DIR to a temp dir and
 * permits loopback fixtures before importing the modules under test.
 * Fallback (JSON file) store only — no Postgres exists on this
 * machine, so the Postgres path stays compile-verified (see PR).
 * Run: node scripts/test-plans.ts
 */
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "pl-plans-"));
process.env.PRELAUNCH_DATA_DIR = dataDir;
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.PRO_EMAILS;

// "@/" alias hook (same as test-waitlist.ts): maps the repo's "@/..."
// alias to the repo root and "next/server" to its server.js entry.
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

const {
  FREE_PLAN,
  PRO_PLAN,
  checkCreateAllowed,
  clampIntervalForPlan,
  clampIntervalMinutes,
  planForEmail,
} = await import("../lib/plans.ts");
const {
  createMonitor,
  findActiveMonitorByEmailUrl,
  getStoredMonitor,
  listActiveMonitorsByEmail,
  normalizeStoredMonitor,
  updateStoredMonitor,
} = await import("../lib/monitor.ts");
const { normalizeUrl } = await import("../lib/scanner.ts");
const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/monitor/route.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

/* ---------- pure gate (prototype parity) ---------- */

// Plan shapes: free is 1 passive monitor, daily; pro is 10, full, hourly.
check(
  "plans: free 1/passive/1440, pro 10/full/60",
  FREE_PLAN.maxMonitors === 1 && !FREE_PLAN.allowFullMode &&
    FREE_PLAN.minIntervalMinutes === 1440 &&
    PRO_PLAN.maxMonitors === 10 && PRO_PLAN.allowFullMode &&
    PRO_PLAN.minIntervalMinutes === 60,
);

// Plan lookup: PRO_EMAILS is the pre-billing stand-in (step 6 swaps it).
{
  delete process.env.PRO_EMAILS;
  check("lookup: unset env is free", planForEmail("a@example.com").id === "free");
  process.env.PRO_EMAILS = " Pro@Example.com , other@example.com ";
  check("lookup: listed email is pro (case/space-insensitive)", planForEmail("pro@example.com").id === "pro");
  check("lookup: unlisted email stays free", planForEmail("nope@example.com").id === "free");
  delete process.env.PRO_EMAILS;
}

// Absolute interval clamp still holds (plans.ts carries its own copy).
check(
  "interval clamp",
  clampIntervalMinutes(30) === 60 && clampIntervalMinutes(20000) === 10080 &&
    clampIntervalMinutes(1440) === 1440 && clampIntervalMinutes("x" as never) === 1440,
);

// Plan floor dominates the absolute clamp.
check(
  "plan interval: free floor 1440",
  clampIntervalForPlan(FREE_PLAN, 60) === 1440 &&
    clampIntervalForPlan(FREE_PLAN, 2880) === 2880,
);
check(
  "plan interval: pro floor 60",
  clampIntervalForPlan(PRO_PLAN, 30) === 60 &&
    clampIntervalForPlan(PRO_PLAN, 360) === 360,
);

// Creation gate.
check(
  "gate: free first passive allowed",
  checkCreateAllowed(FREE_PLAN, { existingCount: 0, duplicate: false, mode: "passive" }).allowed,
);
{
  const over = checkCreateAllowed(FREE_PLAN, { existingCount: 1, duplicate: false, mode: "passive" });
  check(
    "gate: free second monitor is a limit rejection",
    !over.allowed && over.code === "limit" && over.reason.includes("upgrade"),
  );
}
{
  const mode = checkCreateAllowed(FREE_PLAN, { existingCount: 0, duplicate: false, mode: "full" });
  check(
    "gate: free full mode is a mode rejection",
    !mode.allowed && mode.code === "mode" && mode.reason.includes("Pro"),
  );
}
{
  const dup = checkCreateAllowed(FREE_PLAN, { existingCount: 1, duplicate: true, mode: "passive" });
  check("gate: duplicate beats limit", !dup.allowed && dup.code === "duplicate");
}
check(
  "gate: pro 10th monitor allowed, 11th not",
  checkCreateAllowed(PRO_PLAN, { existingCount: 9, duplicate: false, mode: "full" }).allowed &&
    !checkCreateAllowed(PRO_PLAN, { existingCount: 10, duplicate: false, mode: "full" }).allowed,
);

// Legacy monitor rows backfill to the free plan; pro is preserved.
{
  type Stored = Parameters<typeof normalizeStoredMonitor>[0];
  const base = {
    id: "m1",
    url: "https://example.com",
    secretHash: "x",
    createdAt: new Date().toISOString(),
    running: false,
    runs: [],
  } as unknown as Stored;
  check("normalize backfills plan free", normalizeStoredMonitor(base).plan === "free");
  check(
    "normalize keeps plan pro",
    normalizeStoredMonitor({ ...base, plan: "pro" } as Stored).plan === "pro",
  );
}

/* ---------- store integration (fallback store) ---------- */

const FIXTURE = "http://127.0.0.1:4321";
const fixtureUrl = normalizeUrl(FIXTURE);

// Free owner: first monitor created with a plan — cadence floored to
// the Free daily minimum and the plan recorded on the monitor.
const freeEmail = "free@example.com";
const first = await createMonitor(FIXTURE, undefined, {
  email: freeEmail,
  intervalMinutes: 60,
  plan: FREE_PLAN,
});
const firstStored = await getStoredMonitor(first.id);
check(
  "create: free plan floors interval 60 → 1440 and records plan",
  firstStored?.intervalMinutes === 1440 && firstStored?.plan === "free",
  `interval=${firstStored?.intervalMinutes} plan=${firstStored?.plan}`,
);

// Counting + duplicate detection, composed exactly as the route does.
{
  const mine = await listActiveMonitorsByEmail(freeEmail);
  const existing = await findActiveMonitorByEmailUrl(freeEmail, fixtureUrl);
  check("count: free owner has 1 active monitor", mine.length === 1, `got ${mine.length}`);
  check("duplicate: same owner + normalized URL is found", existing?.id === first.id);
  const dupGate = checkCreateAllowed(FREE_PLAN, {
    existingCount: mine.length,
    duplicate: existing !== null,
    mode: "passive",
  });
  check(
    "gate composition: duplicate → duplicate code (route maps to 409)",
    !dupGate.allowed && dupGate.code === "duplicate",
  );
  const limitGate = checkCreateAllowed(FREE_PLAN, {
    existingCount: mine.length,
    duplicate: false,
    mode: "passive",
  });
  check(
    "gate composition: at free max → limit code (route maps to 402 plan_limit)",
    !limitGate.allowed && limitGate.code === "limit",
  );
}

// Disabled monitors do not count (prototype `active` semantics): the
// slot frees up and the duplicate guard clears.
{
  const stored = await getStoredMonitor(first.id);
  if (!stored) throw new Error("monitor vanished");
  stored.enabled = false;
  await updateStoredMonitor(stored);
  const mine = await listActiveMonitorsByEmail(freeEmail);
  const existing = await findActiveMonitorByEmailUrl(freeEmail, fixtureUrl);
  check(
    "count: disabled monitor frees the plan slot",
    mine.length === 0 && existing === null,
    `count=${mine.length} existing=${existing?.id ?? "null"}`,
  );
}

// Pro owner (PRO_EMAILS): hourly floor applies, plan recorded as pro,
// and a second monitor is within the gate.
{
  process.env.PRO_EMAILS = "pro@example.com";
  const proPlan = planForEmail("pro@example.com");
  const proEmail = "pro@example.com";
  const a = await createMonitor(`${FIXTURE}/a`, undefined, {
    email: proEmail,
    intervalMinutes: 30,
    plan: proPlan,
  });
  const aStored = await getStoredMonitor(a.id);
  check(
    "create: pro plan floors interval 30 → 60 and records plan",
    aStored?.intervalMinutes === 60 && aStored?.plan === "pro",
    `interval=${aStored?.intervalMinutes} plan=${aStored?.plan}`,
  );
  await createMonitor(`${FIXTURE}/b`, undefined, { email: proEmail, plan: proPlan });
  const mine = await listActiveMonitorsByEmail(proEmail);
  const gate = checkCreateAllowed(proPlan, {
    existingCount: mine.length,
    duplicate: false,
    mode: "full",
  });
  check(
    "count: pro owner at 2 of 10, gate still allows (incl. full mode)",
    mine.length === 2 && gate.allowed,
    `count=${mine.length}`,
  );
  delete process.env.PRO_EMAILS;
}

// No plan passed (internal callers): plain 60–10080 clamp, plan
// recorded as the free default — pre-step-5 behavior preserved.
{
  const plain = await createMonitor(`${FIXTURE}/plain`, undefined, {
    email: "plain@example.com",
    intervalMinutes: 60,
  });
  const stored = await getStoredMonitor(plain.id);
  check(
    "create: no plan keeps the plain clamp (60 stays 60)",
    stored?.intervalMinutes === 60 && stored?.plan === "free",
    `interval=${stored?.intervalMinutes} plan=${stored?.plan}`,
  );
}

/* ---------- route (real POST /api/monitor handler) ---------- */

function post(body: unknown, ip: string): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/monitor", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

// Free owner: first creation succeeds with plan + usage in the body
// and the interval-raise note (hourly request on a daily plan).
{
  const res = await post(
    { url: FIXTURE, email: "route-free@example.com", intervalMinutes: 60 },
    "203.0.113.31",
  );
  const body = (await res.json()) as {
    plan?: { id?: string };
    usage?: { monitors?: number; maxMonitors?: number };
    note?: string;
  };
  check(
    "route: free create → 201 with plan + usage + floor note",
    res.status === 201 && body.plan?.id === "free" &&
      body.usage?.monitors === 1 && body.usage?.maxMonitors === 1 &&
      (body.note ?? "").includes("1440"),
    `status=${res.status} body=${JSON.stringify(body)}`,
  );
}

// Same owner + same URL → 409 duplicate with the existing dashboard.
{
  const res = await post(
    { url: FIXTURE, email: "route-free@example.com" },
    "203.0.113.32",
  );
  const body = (await res.json()) as { code?: string; dashboard?: string };
  check(
    "route: duplicate → 409 code=duplicate with dashboard link",
    res.status === 409 && body.code === "duplicate" &&
      (body.dashboard ?? "").includes("/m/"),
    `status=${res.status} body=${JSON.stringify(body)}`,
  );
}

// Same owner, different URL, already at the Free cap → 402 plan_limit.
{
  const res = await post(
    { url: `${FIXTURE}/other`, email: "route-free@example.com" },
    "203.0.113.33",
  );
  const body = (await res.json()) as {
    code?: string;
    limit?: number;
    upgrade?: string;
    plan?: { id?: string };
  };
  check(
    "route: free second monitor → 402 plan_limit with limit + upgrade hint",
    res.status === 402 && body.code === "plan_limit" && body.limit === 1 &&
      body.plan?.id === "free" && typeof body.upgrade === "string",
    `status=${res.status} body=${JSON.stringify(body)}`,
  );
}

// Fresh Free owner asking for full mode → 402 code=mode.
{
  const res = await post(
    { url: FIXTURE, email: "route-mode@example.com", mode: "full" },
    "203.0.113.34",
  );
  const body = (await res.json()) as { code?: string };
  check(
    "route: free full mode → 402 code=mode",
    res.status === 402 && body.code === "mode",
    `status=${res.status} body=${JSON.stringify(body)}`,
  );
}

// PRO_EMAILS owner through the route: Pro plan, 10-monitor usage,
// hourly floor note.
{
  process.env.PRO_EMAILS = "boss@example.com";
  const res = await post(
    { url: FIXTURE, email: "boss@example.com", intervalMinutes: 30 },
    "203.0.113.35",
  );
  const body = (await res.json()) as {
    plan?: { id?: string };
    usage?: { monitors?: number; maxMonitors?: number };
    note?: string;
  };
  check(
    "route: pro create → 201 plan=pro, usage 1/10, floor note 60",
    res.status === 201 && body.plan?.id === "pro" &&
      body.usage?.monitors === 1 && body.usage?.maxMonitors === 10 &&
      (body.note ?? "").includes("60"),
    `status=${res.status} body=${JSON.stringify(body)}`,
  );
  delete process.env.PRO_EMAILS;
}

// No email: legacy token-owned creation is unchanged (201 + hook).
{
  const res = await post({ url: `${FIXTURE}/anon` }, "203.0.113.36");
  const body = (await res.json()) as { id?: string; deployHook?: string };
  check(
    "route: email-less create → 201 with deploy hook (unchanged)",
    res.status === 201 && typeof body.id === "string" &&
      (body.deployHook ?? "").includes("token="),
    `status=${res.status} body=${JSON.stringify(body)}`,
  );
}

if (failures > 0) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log("all plan checks pass");
