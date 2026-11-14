/**
 * The GitHub Action (action/): pure helpers plus full runs of
 * action/index.mjs as GitHub would run it (INPUT_* env, event file,
 * GITHUB_OUTPUT / GITHUB_STEP_SUMMARY files), against a stub Prelaunch
 * server, a stub GitHub API and a stub OIDC token endpoint.
 *
 * - Target: explicit url wins; deployment_status success → environment
 *   URL; non-success deployment → skipped (exit 0); nothing → error.
 * - Summary: counts, blockers listed, site text sanitised (no @mentions,
 *   no HTML, no newlines), partial-scan note, fail-on decisions.
 * - Runs: OIDC used when no api-key (audience "prelaunch"); api-key sent
 *   as bearer when given; blockers fail the step; outputs and summary
 *   written; one PR comment posted, then updated in place on the next
 *   run; PR found from the deployment's commit; 402 gives the key hint;
 *   fail-on never turns errors into warnings; busy 429 is retried.
 *
 * Run: node scripts/test-ci-action.ts
 */
import { spawn } from "node:child_process";
import { promises as fs, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

const actionDir = fileURLToPath(new URL("../action/", import.meta.url));
const lib = await import(new URL("../action/lib.mjs", import.meta.url).href);

// ---------- pure helpers ----------
check("target: explicit url wins", lib.resolveTarget({ inputUrl: " https://x.dev ", eventName: "deployment_status", event: {} }).url === "https://x.dev");
check("target: deployment_status success → environment_url",
  lib.resolveTarget({ inputUrl: "", eventName: "deployment_status", event: { deployment_status: { state: "success", environment_url: "https://app-git-feat.vercel.app" } } }).url === "https://app-git-feat.vercel.app");
check("target: pending deployment skipped",
  !!lib.resolveTarget({ inputUrl: "", eventName: "deployment_status", event: { deployment_status: { state: "pending" } } }).skip);
check("target: pull_request without url → error", !!lib.resolveTarget({ inputUrl: "", eventName: "pull_request", event: {} }).error);
check("pr: from pull_request event", lib.prNumberFromEvent({ eventName: "pull_request", event: { pull_request: { number: 7 } } }) === 7);
check("pr: none on deployment_status", lib.prNumberFromEvent({ eventName: "deployment_status", event: {} }) === null);
check("sha: deployment sha preferred", lib.shaFromEvent({ eventName: "deployment_status", event: { deployment: { sha: "abc" } }, envSha: "def" }) === "abc");
check("fail-on: default blocker", lib.parseFailOn("") === "blocker");
let threw = false;
try { lib.parseFailOn("sometimes"); } catch { threw = true; }
check("fail-on: invalid value refused", threw);
const counts = { blocker: 0, warning: 2, info: 1 };
check("fail-on: warnings pass under blocker", !lib.shouldFail(counts, "blocker"));
check("fail-on: warnings fail under warning", lib.shouldFail(counts, "warning"));
check("fail-on: never never fails", !lib.shouldFail({ blocker: 3, warning: 0, info: 0 }, "never"));
const nasty = lib.sanitize("hi @octocat <img src=x>\n**bold** [link](http://e) `x`");
check("sanitize: no mention, no html, one line", !/@octocat/.test(nasty) && !nasty.includes("<") && !nasty.includes("\n") && nasty.includes("\\*\\*"), nasty);
check("sanitize: capped", lib.sanitize("a".repeat(500)).length <= 160);
check("sanitizeCode: no backticks", !lib.sanitizeCode("a`b").includes("`"));
check("protected: Vercel 401 spotted", lib.looksLikeProtectedVercel(401, { server: "Vercel" }));
check("protected: Vercel SSO redirect spotted", lib.looksLikeProtectedVercel(307, { server: "Vercel", location: "https://vercel.com/sso-api?url=x" }));
check("protected: other 401s and normal pages ignored", !lib.looksLikeProtectedVercel(401, { server: "nginx" }) && !lib.looksLikeProtectedVercel(200, { server: "Vercel" }));
check("retry: busy 30s retried, hourly not", lib.retryDelaySeconds(429, "30") === 30 && lib.retryDelaySeconds(429, "3600") === null && lib.retryDelaySeconds(401, null) === null);

const sampleResult = {
  id: "s1", url: "https://app-git-feat.vercel.app", grade: "D", score: 58, status: "done",
  findings: [
    { checkId: "exposed-env", severity: "blocker", title: ".env is public @octocat", location: "/.env", fix: "Remove it from the deploy" },
    { checkId: "headers", severity: "warning", title: "Missing CSP", location: "/", fix: "Add a CSP" },
    { checkId: "seo", severity: "info", title: "No sitemap", location: "/sitemap.xml", fix: "Add one" },
  ],
  progress: [
    { id: "a", status: "done", outcome: "issues" },
    { id: "b", status: "done", outcome: "not_run" },
  ],
};
const s = lib.renderSummary({ result: sampleResult, reportUrl: "https://p/r/s1", failOn: "blocker" });
check("summary: starts with the marker", s.markdown.startsWith(lib.COMMENT_MARKER));
check("summary: counts and grade", /grade D \(58\/100\)/.test(s.markdown) && /1 blocker, 1 warning, 1 info/.test(s.markdown), s.markdown);
check("summary: blocker listed with fix", s.markdown.includes(".env is public") && s.markdown.includes("Remove it from the deploy"));
check("summary: partial note", /1 check didn't finish/.test(s.markdown));
check("summary: fails on blockers", s.failed === true);

// ---------- full runs ----------
type Call = { method: string; url: string; auth?: string; body?: string };
const calls: Call[] = [];
let mode: "ok" | "clean" | "402" | "busy" = "ok";
let busyLeft = 0;
let polls = 0;
const comments: { id: number; body: string }[] = [];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = req.url ?? "";
  calls.push({ method: req.method ?? "", url, auth: req.headers.authorization, body });
  if (url === "/protected-preview") {
    res.writeHead(401, { server: "Vercel", "content-type": "text/html" });
    return res.end("Authentication Required");
  }
  // OIDC token endpoint
  if (url.startsWith("/oidc")) {
    if (req.headers.authorization !== "bearer runtime-token") return json(res, 403, {});
    return json(res, 200, { value: `${Buffer.from("{}").toString("base64url")}.e30.sig-${new URL(url, "http://x").searchParams.get("audience")}` });
  }
  // Prelaunch
  if (url === "/api/ci/scan" && req.method === "POST") {
    if (mode === "402") { res.writeHead(402); return res.end("Private repositories need a Prelaunch key"); }
    if (mode === "busy" && busyLeft > 0) { busyLeft--; res.writeHead(429, { "retry-after": "1" }); return res.end("server busy"); }
    polls = 0;
    return json(res, 200, { id: "s1", tier: "free", statusUrl: "/api/scan/s1", resultUrl: "/api/report/s1?format=json", reportUrl: "/r/s1" });
  }
  if (url === "/api/scan/s1") {
    polls++;
    return json(res, 200, { id: "s1", status: polls < 2 ? "running" : "done", progress: [{ name: "Headers", status: "running" }] });
  }
  if (url === "/api/report/s1?format=json") {
    return json(res, 200, mode === "clean" ? { ...sampleResult, grade: "A", score: 97, findings: [], progress: [] } : sampleResult);
  }
  // GitHub API
  if (url === "/repos/octo/app/commits/deadbeef/pulls") {
    return json(res, 200, [{ number: 12, state: "open", head: { sha: "deadbeef" } }, { number: 3, state: "closed", head: { sha: "deadbeef" } }]);
  }
  if (url.startsWith("/repos/octo/app/issues/12/comments") && req.method === "GET") {
    return json(res, 200, [{ id: 1, body: "unrelated" }, ...comments]);
  }
  if (url === "/repos/octo/app/issues/12/comments" && req.method === "POST") {
    const c = { id: 100 + comments.length, body: JSON.parse(body).body };
    comments.push(c);
    return json(res, 201, c);
  }
  const m = /^\/repos\/octo\/app\/issues\/comments\/(\d+)$/.exec(url);
  if (m && req.method === "PATCH") {
    const c = comments.find((x) => x.id === Number(m[1]));
    if (!c) return json(res, 404, {});
    c.body = JSON.parse(body).body;
    return json(res, 200, c);
  }
  json(res, 404, { url });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("no port");
const base = `http://127.0.0.1:${addr.port}`;

async function runAction(opts: { inputs?: Record<string, string>; eventName?: string; event?: unknown; oidc?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "pl-action-"));
  const eventPath = join(dir, "event.json");
  const outPath = join(dir, "output");
  const sumPath = join(dir, "summary");
  await fs.writeFile(eventPath, JSON.stringify(opts.event ?? {}));
  await fs.writeFile(outPath, "");
  await fs.writeFile(sumPath, "");
  const inputs = { "prelaunch-url": base, "github-token": "gh-token", comment: "true", "fail-on": "blocker", ...opts.inputs };
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "",
    GITHUB_EVENT_NAME: opts.eventName ?? "deployment_status",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outPath,
    GITHUB_STEP_SUMMARY: sumPath,
    GITHUB_REPOSITORY: "octo/app",
    GITHUB_SHA: "deadbeef",
    GITHUB_API_URL: base,
    PRELAUNCH_ACTION_POLL_MS: "20",
  };
  for (const [k, val] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = val;
  if (opts.oidc !== false) {
    env.ACTIONS_ID_TOKEN_REQUEST_URL = `${base}/oidc?api-version=2.0`;
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runtime-token";
  }
  const child = spawn(process.execPath, [join(actionDir, "index.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d));
  child.stderr.on("data", (d: Buffer) => (stdout += d));
  const code = await new Promise<number>((r) => child.on("close", (c: number | null) => r(c ?? -1)));
  return { code, stdout, outputs: await fs.readFile(outPath, "utf8"), summary: await fs.readFile(sumPath, "utf8") };
}

const deployEvent = {
  deployment: { sha: "deadbeef" },
  deployment_status: { state: "success", environment_url: "https://app-git-feat.vercel.app" },
};

try {
  // 1. Vercel preview, public repo (OIDC), blockers → fail, comment posted.
  calls.length = 0;
  const r1 = await runAction({ event: deployEvent });
  const start = calls.find((c) => c.url === "/api/ci/scan");
  check("run: OIDC token requested for audience prelaunch", calls.some((c) => c.url.includes("audience=prelaunch")));
  check("run: OIDC token sent as bearer", !!start?.auth?.startsWith("Bearer ") && start.auth.endsWith("sig-prelaunch"), start?.auth);
  check("run: scans the preview URL", JSON.parse(start?.body ?? "{}").url === "https://app-git-feat.vercel.app");
  check("run: blockers fail the step", r1.code === 1, r1.stdout);
  check("run: ::error:: annotation", r1.stdout.includes("::error::Prelaunch found 1 launch blocker"));
  check("run: outputs written", /grade=D/.test(r1.outputs) && /blockers=1/.test(r1.outputs) && /report-url=.*\/r\/s1/.test(r1.outputs) && /scan-id=s1/.test(r1.outputs), r1.outputs);
  check("run: job summary written", r1.summary.includes("Prelaunch: grade D"));
  check("run: PR found from the deployment's commit and commented", comments.length === 1 && comments[0].body.startsWith(lib.COMMENT_MARKER));

  // 2. Second run updates the same comment rather than adding another.
  mode = "clean";
  const r2 = await runAction({ event: deployEvent });
  check("run: clean scan passes", r2.code === 0, r2.stdout);
  check("run: comment updated in place", comments.length === 1 && comments[0].body.includes("grade A"), JSON.stringify(comments));

  // 3. api-key given: sent as bearer, no OIDC request.
  calls.length = 0;
  const r3 = await runAction({ event: deployEvent, inputs: { "api-key": "plk_test" } });
  check("run: api-key sent as bearer, OIDC not used",
    calls.find((c) => c.url === "/api/ci/scan")?.auth === "Bearer plk_test" && !calls.some((c) => c.url.startsWith("/oidc")) && r3.code === 0);

  // 4. Private repo without key → 402 with hint, step fails.
  mode = "402";
  const r4 = await runAction({ event: deployEvent });
  check("run: 402 explains the paid key", r4.code === 1 && /needs a paid key/.test(r4.stdout), r4.stdout);
  // ...unless fail-on is never.
  const r5 = await runAction({ event: deployEvent, inputs: { "fail-on": "never" } });
  check("run: fail-on never turns errors into warnings", r5.code === 0 && r5.stdout.includes("::warning::"), r5.stdout);

  // 5. No OIDC permission and no key → clear error.
  mode = "ok";
  const r6 = await runAction({ event: deployEvent, oidc: false });
  check("run: missing id-token permission explained", r6.code === 1 && /id-token: write/.test(r6.stdout), r6.stdout);

  // 6. Pending deployment skipped.
  const r7 = await runAction({ event: { deployment_status: { state: "pending" } } });
  check("run: pending deployment skipped, exit 0", r7.code === 0 && /skipped/.test(r7.stdout));

  // 7. Busy 429 retried, then succeeds; explicit url on pull_request.
  mode = "busy";
  busyLeft = 1;
  const before = comments.length;
  const r8 = await runAction({ eventName: "pull_request", event: { pull_request: { number: 12 } }, inputs: { url: "https://staging.example.com", "fail-on": "never" } });
  check("run: busy 429 retried", r8.code === 0 && /retrying/.test(r8.stdout), r8.stdout);
  check("run: pull_request uses its own PR number", comments.length === before);
  // 8. Preview behind Vercel Deployment Protection: stopped before any scan.
  mode = "ok";
  calls.length = 0;
  const r9 = await runAction({ event: { deployment: { sha: "deadbeef" }, deployment_status: { state: "success", environment_url: `${base}/protected-preview` } } });
  check("run: protected Vercel preview explained, no scan started",
    r9.code === 1 && /Deployment Protection/.test(r9.stdout) && !calls.some((c) => c.url === "/api/ci/scan"), r9.stdout);
} finally {
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
