/**
 * Prelaunch for Chrome (extension/): build, service worker and popup.
 *
 * - Release build: Manifest V3, only activeTab + storage up front, site
 *   access asked per site at scan time, ExtPay.js shipped unmodified, and
 *   no Node or Playwright code in the bundles.
 * - Service worker (the real built background.js, run in a vm with a fake
 *   chrome API and the test build's fake ExtPay):
 *   - free users get the quick tier: the API's three checks, counts only,
 *     no findings; its grade matches lib/quickcheck.ts on the same site;
 *   - paid users get every fetch-only passive check with findings;
 *   - the paid status comes from ExtPay in the worker, so a cached full
 *     report isn't shown after the plan lapses, and ExtPay being offline
 *     falls back to the free tier with a note;
 *   - only the scanned host is fetched (a script on another host is never
 *     requested); scan fetches follow redirects and send cookies, other
 *     fetches are untouched;
 *   - unreachable sites, non-web tabs, overlapping scans and messages from
 *     other extensions are refused.
 * - Popup (built popup.html + popup.js in jsdom, wired to that worker):
 *   free and paid renders, the unlock button, a denied site permission,
 *   a non-web tab, and page-controlled text rendered as text, not HTML.
 *
 * No real Chrome here: the sandbox can't download a browser, so loading
 * the unpacked extension in Chrome is a manual step (extension/README.md).
 * Run: node scripts/test-chrome-extension.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { registerAliasHooks } from "./node-alias-hooks.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

const root = resolve(fileURLToPath(import.meta.url), "../..");
const ext = join(root, "extension");
const dist = join(ext, "dist");
const read = (p: string) => readFileSync(join(dist, p), "utf8");

// ---------- release build ----------
execFileSync("node", ["build.mjs"], { cwd: ext, stdio: "pipe" });
const manifest = JSON.parse(read("manifest.json"));
check("release: Manifest V3", manifest.manifest_version === 3);
check("release: only activeTab + storage up front", JSON.stringify(manifest.permissions) === '["activeTab","storage"]');
check("release: no install-time host access", manifest.host_permissions === undefined);
check(
  "release: site access is optional, asked per site",
  JSON.stringify(manifest.optional_host_permissions) === '["https://*/*","http://*/*"]',
);
check("release: classic service worker loads ExtPay first", manifest.background?.service_worker === "background.js" && read("background.js").startsWith('importScripts("ExtPay.js");'));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
check(
  "release: ExtPay.js shipped unmodified",
  sha(readFileSync(join(dist, "ExtPay.js"))) === sha(readFileSync(join(ext, "node_modules/extpay/dist/ExtPay.js"))),
);
for (const f of ["background.js", "popup.js"]) {
  const src = read(f);
  check(`release: ${f} has no Node/Playwright imports`, !/require\(["'](node:|playwright|pg|@vercel)/.test(src) && !/from ["']node:/.test(src));
  check(`release: ${f} has no eval / new Function`, !/\beval\(|new Function\(/.test(src));
}
check("release: background bundles the real checks", /sourcesContent/.test(read("background.js")) && /error-verbosity/.test(read("background.js")));
check("release: icons present", ["16", "32", "48", "128"].every((s) => readFileSync(join(dist, `icons/icon-${s}.png`)).subarray(1, 4).toString() === "PNG"));

// ---------- test build ----------
execFileSync("node", ["build.mjs", "--test"], { cwd: ext, stdio: "pipe" });
check("test build: marked and pre-allowed", /test build/.test(JSON.parse(read("manifest.json")).name));

// ---------- fixtures ----------
const hits: Record<string, string[]> = { leaky: [], clean: [], other: [], redirect: [] };
function listen(name: string, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    hits[name].push(req.url ?? "");
    handler(req, res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as AddressInfo).port })));
}
// A script host other than the scanned site. The extension must never
// fetch it; the hosted check may (it allows any public host), so its map
// 404s to keep the parity comparison about the same requests.
const other = await listen("other", (req, res) => {
  if ((req.url ?? "").endsWith(".map")) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/javascript" });
  res.end("console.log('other')");
});
const leaky = await listen("leaky", (req, res) => {
  const url = req.url ?? "/";
  if (url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><html><head><title>Leaky</title></head><body>` +
        `<script src="/app.js"></script>` +
        `<script src="http://localhost:${other.port}/evil.js"></script>` +
        `<script src="/x/%3Cimg%20src=x%20onerror=alert(1)%3E.js"></script>` +
        `</body></html>`,
    );
  } else if (url === "/.env") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("API_KEY=abc123\nDB_PASSWORD=hunter2\n");
  } else if (url === "/app.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("console.log(1)");
  } else if (url === "/app.js.map" || url.endsWith(".js.map")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: 3, sources: ["a.ts"], sourcesContent: ["secret()"] }));
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>soft 404</body></html>");
  }
});
const SECURE = {
  "content-security-policy": "default-src 'self'",
  "strict-transport-security": "max-age=63072000",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=()",
};
const clean = await listen("clean", (req, res) => {
  if ((req.url ?? "/") === "/") {
    res.writeHead(200, { "content-type": "text/html", ...SECURE });
    res.end("<!doctype html><html><head><title>Clean</title></head><body>hi</body></html>");
  } else {
    res.writeHead(404, { "content-type": "text/html", ...SECURE });
    res.end("not found");
  }
});
const redirect = await listen("redirect", (req, res) => {
  if ((req.url ?? "/") === "/") {
    res.writeHead(302, { location: "/start" });
    res.end();
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>start</body></html>");
  }
});
const at = (port: number) => `http://127.0.0.1:${port}`;

// ---------- service worker in a vm ----------
const EXT_ID = "prelaunchtestid";
const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const area = (m: Map<string, unknown>) => ({
  async get(keys: string | string[]) {
    const out: Record<string, unknown> = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) if (m.has(k)) out[k] = structuredClone(m.get(k));
    return out;
  },
  async set(obj: Record<string, unknown>) {
    for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v));
  },
});
let listener: ((msg: unknown, sender: { id?: string }, respond: (v: unknown) => void) => boolean) | null = null;
const fetchLog: Array<{ url: string; init: RequestInit }> = [];
const chromeApi = {
  runtime: { id: EXT_ID, onMessage: { addListener: (fn: typeof listener) => (listener = fn) } },
  storage: { local: area(local), session: area(session) },
};
const sandbox: Record<string, unknown> = {
  chrome: chromeApi,
  console,
  URL,
  Headers,
  Response,
  Request,
  AbortController,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
  structuredClone,
  fetch: (input: string | URL | Request, init: RequestInit = {}) => {
    fetchLog.push({ url: String(input instanceof Request ? input.url : input), init });
    return fetch(input, init);
  },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.importScripts = (file: string) => vm.runInContext(read(file), sandbox);
vm.createContext(sandbox);
vm.runInContext(read("background.js"), sandbox);
check("worker: registers a message listener", typeof listener === "function");

function call<T = any>(msg: unknown, senderId = EXT_ID): Promise<{ ok: boolean; value?: T; error?: string } | "no-response"> {
  return new Promise((r) => {
    const kept = listener!(msg, { id: senderId }, (v) => r(v as { ok: boolean; value?: T; error?: string }));
    if (!kept) r("no-response");
  });
}
const ok = async <T = any>(msg: unknown): Promise<T> => {
  const res = await call<T>(msg);
  if (res === "no-response" || !res.ok) throw new Error(`call failed: ${JSON.stringify(res)}`);
  return res.value as T;
};

// free tier
let plan = await ok({ type: "plan" });
check("plan: unpaid by default", plan.paid === false && !plan.error);
const free = (await ok({ type: "scan", target: at(leaky.port) + "/pricing?x=1" })).result;
check("free: quick tier", free.tier === "quick");
check("free: scans the tab's origin", free.url === at(leaky.port));
check("free: the API's three checks", JSON.stringify(free.checks.map((c: any) => c.id)) === '["exposed-env","sourcemap-leak","security-headers"]');
check("free: no findings sent to the popup", Array.isArray(free.findings) && free.findings.length === 0);
check("free: counts the .env blocker", free.summary.blockers >= 1, JSON.stringify(free.summary));
check("free: .env and sourcemap checks found issues", free.checks.find((c: any) => c.id === "exposed-env").outcome === "issues" && free.checks.find((c: any) => c.id === "sourcemap-leak").outcome === "issues");
check("free: names the three locked checks", free.lockedChecks.length === 3 && free.lockedChecks.some((c: any) => c.id === "error-verbosity"));
check("free: not ready", free.ready === false);
check("scope: a script on another host was never requested", hits.other.length === 0, JSON.stringify(hits.other));

// parity with the hosted quick check (lib/quickcheck.ts)
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
process.env.PRELAUNCH_DATA_DIR = mkdtempSync(join(tmpdir(), "pl-ext-"));
await registerAliasHooks(process.env.PRELAUNCH_DATA_DIR);
const quick = await import("../lib/quickcheck.ts");
const hosted = await quick.runQuickCheck(at(leaky.port));
check(
  "parity: same grade and counts as the hosted quick check",
  hosted.grade === free.grade && hosted.score === free.score && JSON.stringify(hosted.summary) === JSON.stringify(free.summary),
  `hosted ${hosted.grade}/${hosted.score} ${JSON.stringify(hosted.summary)} vs ext ${free.grade}/${free.score} ${JSON.stringify(free.summary)}`,
);

// scan fetches: follow redirects, send cookies, no cache
const scanInits = fetchLog.filter((f) => f.url.startsWith(at(leaky.port)));
check("fetch: scan requests follow redirects", scanInits.length > 0 && scanInits.every((f) => f.init.redirect === "follow"));
check("fetch: scan requests send the user's cookies", scanInits.every((f) => f.init.credentials === "include"));
const red = (await ok({ type: "scan", target: at(redirect.port) })).result;
check("fetch: a redirecting home page is scanned, not reported unreachable", red.checks.length === 3 && !red.checks.some((c: any) => c.outcome === "failed"));

// paid tier
local.set("test:paid", true);
plan = await ok({ type: "plan" });
check("plan: paid", plan.paid === true);
const full = (await ok({ type: "scan", target: at(leaky.port) })).result;
check("paid: full tier", full.tier === "full");
check(
  "paid: every fetch-only passive check",
  JSON.stringify(full.checks.map((c: any) => c.id).sort()) ===
    JSON.stringify(["custom-404", "error-verbosity", "exposed-env", "security-headers", "seo-basics", "sourcemap-leak"]),
);
check("paid: findings included", full.findings.length === full.summary.blockers + full.summary.warnings + full.summary.info && full.findings.length > 0);
check("paid: .env blocker with its location", full.findings.some((f: any) => f.severity === "blocker" && f.location === at(leaky.port) + "/.env"));
check("paid: sourcemap warning", full.findings.some((f: any) => f.checkId === "sourcemap-leak"));
check("paid: blockers sorted first", full.findings[0].severity === "blocker");
check("paid: nothing locked", full.lockedChecks.length === 0);
const scanner = await import("../lib/scanner.ts");
check("paid: grade is lib/scanner.ts grade()", scanner.grade(full.findings).grade === full.grade && scanner.grade(full.findings).score === full.score);
const cleanFull = (await ok({ type: "scan", target: at(clean.port) })).result;
check(
  "paid: clean site has no .env, sourcemap or missing-header findings",
  !cleanFull.findings.some((f: any) => f.checkId === "exposed-env" || f.checkId === "sourcemap-leak" || (f.checkId === "security-headers" && f.title !== "Site serves content over plain HTTP")),
  JSON.stringify(cleanFull.findings),
);

// cache follows the plan
let cached = await ok({ type: "cached", target: at(leaky.port) });
check("cache: full report kept for the paid user", cached?.tier === "full");
local.set("test:paid", false);
cached = await ok({ type: "cached", target: at(leaky.port) });
check("cache: full report hidden once the plan lapses", cached === null);

// ExtPay offline -> free tier with a note
local.set("test:offline", true);
plan = await ok({ type: "plan" });
check("offline: plan check fails soft with a note", plan.paid === false && /ExtensionPay/.test(plan.error ?? ""));
const offlineScan = await ok({ type: "scan", target: at(clean.port) });
check("offline: falls back to the quick tier", offlineScan.result.tier === "quick" && /ExtensionPay/.test(offlineScan.plan.error));
local.delete("test:offline");

// refusals
const dead = await call({ type: "scan", target: "http://127.0.0.1:1" });
check("refuse: unreachable site", dead !== "no-response" && !dead.ok && /didn't respond/.test(dead.error ?? ""));
const chromePage = await call({ type: "scan", target: "chrome://extensions" });
check("refuse: non-web tab", chromePage !== "no-response" && !chromePage.ok && /http or https/.test(chromePage.error ?? ""));
const [a, b] = await Promise.all([call({ type: "scan", target: at(clean.port) }), call({ type: "scan", target: at(clean.port) })]);
check(
  "refuse: overlapping scans",
  a !== "no-response" && b !== "no-response" && [a, b].filter((r) => r.ok).length === 1 && [a, b].some((r) => /already running/.test(r.error ?? "")),
);
check("refuse: messages from other extensions", (await call({ type: "plan" }, "someone-else")) === "no-response");
await ok({ type: "pay" });
check("pay: opens the ExtensionPay page", local.get("test:opened") === "payment");
await ok({ type: "login" });
check("login: opens the ExtensionPay login page", local.get("test:opened") === "login");

// ---------- popup in jsdom ----------
const req = createRequire(join(ext, "package.json"));
// jsdom lives in extension/node_modules (a dev dependency of the extension only).
const { JSDOM } = req("jsdom") as { JSDOM: new (html: string, opts: object) => { window: unknown } };

async function popup(opts: { url: string; grant?: boolean; paid?: boolean }) {
  local.set("test:paid", opts.paid === true);
  const dom = new JSDOM(read("popup.html").replace(/<script[^>]*><\/script>/, ""), { runScripts: "outside-only", url: "chrome-extension://prelaunchtestid/popup.html" });
  const w = dom.window as any;
  const asks: unknown[] = [];
  w.chrome = {
    tabs: { query: async () => [{ url: opts.url }] },
    permissions: {
      request: async (p: unknown) => {
        asks.push(p);
        return opts.grant !== false;
      },
    },
    runtime: { sendMessage: (msg: unknown) => call(msg).then((r) => (r === "no-response" ? undefined : r)) },
  };
  w.eval(read("popup.js"));
  const doc = w.document as Document;
  const until = async (pred: () => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return pred();
  };
  const buttons = () => [...doc.querySelectorAll("button")] as HTMLButtonElement[];
  const btn = (text: string) => buttons().find((x) => x.textContent === text);
  return { doc, asks, until, btn };
}

session.clear();
let p = await popup({ url: at(leaky.port) + "/a/page" });
check("popup: shows the site", await p.until(() => p.doc.getElementById("site")!.textContent === `127.0.0.1:${leaky.port}`));
check("popup: offers a scan", await p.until(() => !!p.btn("Scan this site")));
p.btn("Scan this site")!.click();
check("popup: asks for this site only, both schemes", await p.until(() => p.asks.length === 1) && JSON.stringify(p.asks[0]) === JSON.stringify({ origins: [`https://127.0.0.1:${leaky.port}/*`, `http://127.0.0.1:${leaky.port}/*`] }));
check("popup free: shows a grade", await p.until(() => !!p.doc.querySelector(".letter")), p.doc.getElementById("app")!.textContent ?? "");
check("popup free: unlock button", !!p.btn("Unlock the full report"));
check("popup free: no finding details", p.doc.querySelectorAll(".finding").length === 0);
check("popup free: locked checks listed", p.doc.querySelectorAll(".outcome.locked").length === 3);
check("popup free: login link for past buyers", p.doc.getElementById("account")!.textContent === "Already paid? Log in");
local.delete("test:opened");
p.btn("Unlock the full report")!.click();
check("popup free: unlock opens payment", await p.until(() => local.get("test:opened") === "payment"));

session.clear();
p = await popup({ url: at(leaky.port), paid: true });
await p.until(() => !!p.btn("Scan this site"));
p.btn("Scan this site")!.click();
check("popup paid: finding cards", await p.until(() => p.doc.querySelectorAll(".finding").length > 0));
check("popup paid: export buttons", !!p.btn("Copy as Markdown") && !!p.btn("Download JSON"));
check("popup paid: manage plan", p.doc.getElementById("account")!.textContent === "Manage plan");
check("popup: page-controlled text stays text", p.doc.querySelectorAll("#app img").length === 0 && /onerror/.test(p.doc.getElementById("app")!.textContent ?? ""));

p = await popup({ url: at(leaky.port), paid: true });
check("popup paid: reopening shows the last report", await p.until(() => p.doc.querySelectorAll(".finding").length > 0));

session.clear();
p = await popup({ url: at(clean.port), grant: false });
await p.until(() => !!p.btn("Scan this site"));
p.btn("Scan this site")!.click();
check("popup: denied access explains and scans nothing", await p.until(() => /needs your OK/.test(p.doc.getElementById("app")!.textContent ?? "")));

p = await popup({ url: "chrome://newtab/" });
check("popup: non-web tab", await p.until(() => /http or https/.test(p.doc.getElementById("app")!.textContent ?? "")));

for (const s of [leaky, clean, other, redirect]) s.server.close();
// Leave a release build in dist, so a manual "Load unpacked" never picks up the test build.
execFileSync("node", ["build.mjs"], { cwd: ext, stdio: "pipe" });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
