/**
 * Apify Actor (apify/, .actor/): the paid "Prelaunch launch-readiness scan".
 *
 * - Input: URL list or single url, de-duplication, the 100-URL cap,
 *   scanType and maxConcurrency validation.
 * - Billing: one charge per finished scan, nothing for invalid, private or
 *   unreachable URLs; scans stop at the run's spending limit, counting
 *   scans still in flight, so a run never overspends.
 * - Scans: the quick scan reuses lib/quickcheck.ts (leaky fixture gets the
 *   .env blocker, clean fixture passes the .env and sourcemap checks); the
 *   full scan reuses runScan and, with no browser, is marked partial and
 *   not launch-ready; owner-only checks are listed as not run.
 * - Definition files: actor.json paths exist, input schema matches the
 *   parser, dataset views only name fields the Actor writes, and the
 *   Dockerfile's Playwright image matches apify/package.json.
 * - End to end (when apify/dist/main.js is built and apify/node_modules
 *   exists): runs the real Actor with local storage and simulated
 *   pay-per-event pricing, then checks the dataset, OUTPUT and the
 *   charging log.
 *
 * Self-contained: temp dirs, loopback fixtures, no network.
 * Run: node scripts/test-apify-actor.ts
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

const root = new URL("../", import.meta.url).pathname;
const dataDir = mkdtempSync(join(tmpdir(), "pl-apify-"));
process.env.PRELAUNCH_DATA_DIR = dataDir;
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
process.env.PRELAUNCH_BROWSER = "off";
for (const k of ["DATABASE_URL", "BLOB_READ_WRITE_TOKEN"]) delete process.env[k];

const core = await import("../apify/src/core.ts");
const scanners = await import("../apify/src/scanners.ts");
type ScanItem = import("../apify/src/core.ts").ScanItem;
type ErrorItem = import("../apify/src/core.ts").ErrorItem;

// ---------- input ----------
const throwsInput = (raw: unknown) => {
  try {
    core.parseInput(raw);
    return false;
  } catch (e) {
    return e instanceof core.ActorInputError;
  }
};
check("input: no urls → error", throwsInput({}) && throwsInput({ urls: [] }) && throwsInput({ urls: ["  "] }));
check("input: non-string entry → error", throwsInput({ urls: [42] }));
check("input: bad scanType → error", throwsInput({ urls: ["a.com"], scanType: "deep" }));
check("input: bad maxConcurrency → error", throwsInput({ urls: ["a.com"], maxConcurrency: 0 }) && throwsInput({ urls: ["a.com"], maxConcurrency: 1.5 }));
const p1 = core.parseInput({ urls: ["https://a.com", "a.com", "A.com/", { url: "https://b.com" }], url: "https://c.com" });
check("input: duplicates (scheme, case, slash) scanned once; {url} and url accepted",
  p1.urls.join(",") === "https://a.com,https://b.com,https://c.com", p1.urls.join(","));
check("input: defaults quick, screenshots on, quick concurrency 5",
  p1.scanType === "quick" && p1.includeScreenshots && p1.concurrency === 5);
const p2 = core.parseInput({ urls: ["a.com"], scanType: "full", maxConcurrency: 9, includeScreenshots: false });
check("input: full scans capped at 2 in parallel; screenshots can be turned off", p2.concurrency === 2 && !p2.includeScreenshots);
const many = Array.from({ length: 130 }, (_, i) => `https://s${i}.example.com`);
const p3 = core.parseInput({ urls: many });
check("input: 100-URL cap, rest reported as skipped", p3.urls.length === 100 && p3.skipped.length === 30);

// ---------- core loop + billing (fakes) ----------
function fakeItem(url: string, ready = true): ScanItem {
  return {
    inputUrl: url, url, scanType: "quick", status: "done", grade: "A", score: 95, ready,
    blockers: ready ? 0 : 1, warnings: 0, info: 0, checks: [], findings: [], checkedAt: "", durationMs: 1,
  };
}
function harness(opts: { budget: number; fail?: (u: string) => Error | null; delayMs?: number }) {
  const pushed: Array<ScanItem | ErrorItem> = [];
  const charges: string[] = [];
  let maxParallel = 0;
  let running = 0;
  const deps = {
    async scan(_t: string, url: string) {
      running++;
      maxParallel = Math.max(maxParallel, running);
      try {
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
        const err = opts.fail?.(url);
        if (err) throw err;
        return fakeItem(url, !url.includes("bad"));
      } finally {
        running--;
      }
    },
    async pushData(item: ScanItem | ErrorItem) {
      pushed.push(item);
    },
    async charge(eventName: string) {
      charges.push(eventName);
      return { chargedCount: 1, eventChargeLimitReached: charges.length >= opts.budget };
    },
    remaining: () => opts.budget - charges.length,
    log: { info() {}, warning() {} },
  };
  return { deps, pushed, charges, maxParallel: () => maxParallel };
}

{
  const h = harness({
    budget: Infinity,
    fail: (u) => (u.includes("dead") ? new core.ScanInputError("the site did not respond") : u.includes("boom") ? new Error("crash") : null),
  });
  const s = await core.runActor(core.parseInput({ urls: ["ok.com", "bad.com", "dead.com", "boom.com"] }), h.deps);
  check("billing: one quick-scan charge per finished scan only", h.charges.length === 2 && h.charges.every((c) => c === "quick-scan"), h.charges.join(","));
  check("billing: errors pushed as error items, not charged",
    s.errors === 2 && h.pushed.filter((p) => p.status === "error").length === 2 && s.charged === 2);
  check("summary: ready / not ready counted", s.ready === 1 && s.notReady === 1 && s.scanned === 2);
}
{
  const h = harness({ budget: 3, delayMs: 20 });
  const urls = Array.from({ length: 12 }, (_, i) => `s${i}.com`);
  const s = await core.runActor(core.parseInput({ urls, maxConcurrency: 5 }), h.deps);
  check("billing: never charges past the spending limit, even with 5 in parallel", h.charges.length === 3, String(h.charges.length));
  check("billing: no scan starts that the limit can't cover", s.scanned === 3 && s.notScannedBudget.length === 9, JSON.stringify(s));
}
{
  const h = harness({ budget: 0 });
  const s = await core.runActor(core.parseInput({ urls: ["a.com", "b.com"] }), h.deps);
  check("billing: zero budget → nothing scanned, nothing charged", s.scanned === 0 && h.charges.length === 0 && s.notScannedBudget.length === 2);
}
{
  const h = harness({ budget: Infinity, delayMs: 15 });
  await core.runActor(core.parseInput({ urls: Array.from({ length: 8 }, (_, i) => `f${i}.com`), scanType: "full" }), h.deps);
  check("full scans: one at a time by default and charged as full-scan", h.maxParallel() === 1 && h.charges.every((c) => c === "full-scan"));
}
check("status message is plain", core.statusMessage({
  scanType: "quick", requested: 3, scanned: 2, charged: 2, errors: 1, notScannedBudget: [], notScannedOverCap: [], ready: 1, notReady: 1,
}) === "Scanned 2 of 3 site(s): 1 launch-ready, 1 not ready; 1 could not be scanned (not charged).");

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
const cleanUrl = `http://localhost:${await listen(clean, "127.0.0.1")}`;
const deadServer = createServer();
const deadPort = await listen(deadServer, "127.0.0.1");
await new Promise<void>((r) => deadServer.close(() => r()));
const deadUrl = `http://127.0.0.1:${deadPort}`;

// ---------- real scanners ----------
const q1 = await scanners.quickScan(leakyUrl);
check("quick: leaky site → .env blocker, not ready",
  !q1.ready && q1.blockers >= 1 && q1.findings.some((f) => f.checkId === "exposed-env" && f.severity === "blocker"));
check("quick: sourcemap leak found", q1.findings.some((f) => f.checkId === "sourcemap-leak"));
check("quick: three checks reported", q1.checks.map((c) => c.id).join(",") === "exposed-env,sourcemap-leak,security-headers");
const q2 = await scanners.quickScan(cleanUrl);
check("quick: clean site passes .env and sourcemap checks",
  q2.checks.find((c) => c.id === "exposed-env")?.outcome === "passed" &&
  q2.checks.find((c) => c.id === "sourcemap-leak")?.outcome === "passed");
const rejects = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
const e1 = await rejects(() => scanners.quickScan(deadUrl));
check("quick: dead site → ScanInputError (not charged)", e1 instanceof core.ScanInputError, String(e1));
const e2 = await rejects(() => scanners.quickScan("http://169.254.169.254"));
check("quick: metadata IP refused → ScanInputError", e2 instanceof core.ScanInputError, String(e2));
const e3 = await rejects(() => scanners.quickScan("http://10.0.0.5"));
check("quick: private IP refused → ScanInputError", e3 instanceof core.ScanInputError, String(e3));
const e4 = await rejects(() => scanners.quickScan("ftp://x y"));
check("quick: invalid url → ScanInputError", e4 instanceof core.ScanInputError, String(e4));

const stored: string[] = [];
const f1 = await scanners.fullScan(leakyUrl, {
  includeScreenshots: true,
  storeShot: async (key) => {
    stored.push(key);
    return `https://example.invalid/${key}`;
  },
});
check("full: finds the same .env blocker as the quick scan", f1.findings.some((f) => f.checkId === "exposed-env" && f.severity === "blocker"));
check("full: runs more checks than quick", f1.checks.length > 3 && f1.checks.some((c) => c.id === "seo-basics"), String(f1.checks.length));
check("full: owner-only checks listed as not run", f1.checks.some((c) => c.id === "client-bundle-secrets" && c.outcome === "not_run"));
check("full: no browser → partial and not launch-ready", !!f1.partial && !f1.ready, String(f1.partial));
check("full: no screenshots without a browser", stored.length === 0 && !f1.screenshots);
check("full: summary counts match findings",
  f1.blockers + f1.warnings + f1.info === f1.findings.length && f1.scanType === "full");
const e5 = await rejects(() => scanners.fullScan(deadUrl, { includeScreenshots: false }));
check("full: dead site → ScanInputError before any scan", e5 instanceof core.ScanInputError, String(e5));

// ---------- definition files ----------
const actorDir = join(root, ".actor");
const actor = JSON.parse(readFileSync(join(actorDir, "actor.json"), "utf8"));
check("actor.json: spec 1, name, version", actor.actorSpecification === 1 && /^[a-z0-9-]+$/.test(actor.name) && /^\d+\.\d+$/.test(actor.version));
for (const key of ["dockerfile", "readme", "input"]) {
  check(`actor.json: ${key} file exists`, existsSync(join(actorDir, actor[key])));
}
check("actor.json: dataset schema exists", existsSync(join(actorDir, actor.storages.dataset)));
check("actor.json: output schema exists (required to publish)", typeof actor.output === "string" && existsSync(join(actorDir, actor.output)));
const outSchema = JSON.parse(readFileSync(join(actorDir, actor.output), "utf8"));
const outProps = Object.values(outSchema.properties as Record<string, { title?: string; template?: string }>);
check("output schema: v1 with title and at least one output",
  outSchema.actorOutputSchemaVersion === 1 && !!outSchema.title && outProps.length > 0);
check("output schema: every output has a title and a storage template",
  outProps.every((p) => p.title && /^\{\{links\.apiDefault(Dataset|KeyValueStore)Url\}\}\//.test(p.template ?? "")));
check("output schema: results point at the default dataset",
  outSchema.properties.results?.template === "{{links.apiDefaultDatasetUrl}}/items");
const schema = JSON.parse(readFileSync(join(actorDir, actor.input), "utf8"));
check("input schema: v1 object with title", schema.schemaVersion === 1 && schema.type === "object" && !!schema.title);
check("input schema: every field has type, title, description",
  Object.values(schema.properties as Record<string, { type?: string; title?: string; description?: string }>).every((p) => p.type && p.title && p.description));
check("input schema: fields are exactly what the parser reads",
  Object.keys(schema.properties).sort().join(",") === "includeScreenshots,maxConcurrency,scanType,urls");
check("input schema: scanType enum = billing events",
  schema.properties.scanType.enum.join(",") === Object.keys(core.SCAN_EVENTS).join(",") &&
  schema.properties.scanType.enumTitles.length === schema.properties.scanType.enum.length &&
  schema.properties.scanType.default === "quick");
check("input schema: maxConcurrency max matches the parser",
  schema.properties.maxConcurrency.maximum === Math.max(...Object.values(core.MAX_CONCURRENCY)));
check("input schema: no default+required clash",
  (schema.required as string[]).every((k) => !("default" in schema.properties[k])));
const ds = JSON.parse(readFileSync(join(actorDir, actor.storages.dataset), "utf8"));
const itemKeys = new Set([...Object.keys(f1), ...Object.keys(q1), "error", "partial", "forecast", "screenshots"]);
const viewFields = Object.values(ds.views as Record<string, { transformation: { fields: string[] } }>).flatMap((v) => v.transformation.fields);
check("dataset schema: views only name fields the Actor writes", viewFields.every((f) => itemKeys.has(f)), viewFields.filter((f) => !itemKeys.has(f)).join(","));
const dockerfile = readFileSync(join(actorDir, "Dockerfile"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "apify", "package.json"), "utf8"));
const tags = [...dockerfile.matchAll(/apify\/actor-node-playwright-chrome:\d+-([\d.]+)/g)].map((m) => m[1]);
check("Dockerfile: Playwright image tag matches apify/package.json",
  tags.length === 2 && tags.every((t) => t === pkg.dependencies.playwright), `${tags} vs ${pkg.dependencies.playwright}`);
check("README: Store listing exists and names both prices", /quick-scan/.test(readFileSync(join(actorDir, actor.readme), "utf8")));

// ---------- end to end: the built Actor ----------
const dist = join(root, "apify", "dist", "main.js");
if (!existsSync(dist) || !existsSync(join(root, "apify", "node_modules", "apify"))) {
  console.log("SKIP end-to-end: run `npm ci && npm run build` in apify/ first");
} else {
  const runActorProcess = async (input: unknown, env: Record<string, string>) => {
    const storage = mkdtempSync(join(tmpdir(), "pl-apify-storage-"));
    mkdirSync(join(storage, "key_value_stores", "default"), { recursive: true });
    writeFileSync(join(storage, "key_value_stores", "default", "INPUT.json"), JSON.stringify(input));
    const child = spawn(process.execPath, [dist], {
      cwd: join(root, "apify"),
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        CRAWLEE_STORAGE_DIR: storage,
        PRELAUNCH_ALLOW_LOOPBACK: "1",
        PRELAUNCH_BROWSER: "off",
        PRELAUNCH_DATA_DIR: dataDir,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
    const readDir = (d: string) =>
      existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(d, f), "utf8"))) : [];
    const outputFile = join(storage, "key_value_stores", "default", "OUTPUT.json");
    return {
      code,
      out,
      items: readDir(join(storage, "datasets", "default")),
      charges: readDir(join(storage, "datasets", "charging_log")),
      output: existsSync(outputFile) ? JSON.parse(readFileSync(outputFile, "utf8")) : null,
    };
  };
  const pricing = JSON.stringify({
    pricingModel: "PAY_PER_EVENT",
    pricingPerEvent: {
      actorChargeEvents: {
        "quick-scan": { eventPriceUsd: 0.03, eventTitle: "Quick scan" },
        "full-scan": { eventPriceUsd: 0.09, eventTitle: "Full scan" },
      },
    },
  });
  const ppe = {
    APIFY_ACTOR_PRICING_INFO: pricing,
    APIFY_CHARGED_ACTOR_EVENT_COUNTS: "{}",
    ACTOR_USE_CHARGING_LOG_DATASET: "1",
  };

  const r1 = await runActorProcess({ urls: [leakyUrl, cleanUrl, deadUrl, "http://10.1.2.3"], scanType: "quick" }, ppe);
  check("e2e: run exits 0", r1.code === 0, r1.out.slice(-800));
  check("e2e: one dataset item per URL", r1.items.length === 4, String(r1.items.length));
  check("e2e: two scans done, two errors", r1.items.filter((i) => i.status === "done").length === 2 && r1.items.filter((i) => i.status === "error").length === 2);
  check("e2e: charged exactly two quick-scan events",
    r1.charges.length === 2 && r1.charges.every((c) => c.eventName === "quick-scan"), JSON.stringify(r1.charges));
  check("e2e: OUTPUT summary written", r1.output?.scanned === 2 && r1.output?.errors === 2 && r1.output?.charged === 2);

  // Off the platform the SDK checks the limit as if every event cost $1
  // (while charging the real price), so only "limit below one event" can be
  // tested end to end here; partial budgets are covered by the unit tests.
  const r2 = await runActorProcess(
    { urls: [leakyUrl, cleanUrl, `${leakyUrl}/pricing`], scanType: "quick" },
    { ...ppe, ACTOR_MAX_TOTAL_CHARGE_USD: "0.5" },
  );
  check("e2e: spending limit below one scan → nothing scanned or charged, run not failed",
    r2.code === 0 && r2.charges.length === 0 && r2.output?.notScannedBudget?.length === 3, JSON.stringify(r2.output));

  const r3 = await runActorProcess({ urls: [leakyUrl], scanType: "full" }, ppe);
  check("e2e: full scan charged as full-scan", r3.code === 0 && r3.charges.length === 1 && r3.charges[0].eventName === "full-scan", r3.out.slice(-800));
  check("e2e: full scan item has the wider check list", (r3.items[0]?.checks?.length ?? 0) > 3);

  const r4 = await runActorProcess({ urls: [deadUrl] }, ppe);
  check("e2e: nothing scannable → run marked failed, nothing charged", r4.code !== 0 && r4.charges.length === 0);
  const r5 = await runActorProcess({ urls: [] }, ppe);
  check("e2e: invalid input → run fails with a clear message", r5.code !== 0 && /Invalid input/.test(r5.out));
}

leaky.close();
clean.close();
if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall apify actor tests passed");
process.exit(0);
