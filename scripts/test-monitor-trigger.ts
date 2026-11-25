/**
 * The 6-hourly monitor trigger (.github/workflows/run-monitors.yml) must
 * reach the endpoint over https and must never follow a redirect (issue #52).
 *
 * Runs the workflow's own shell step with a stub `curl` on PATH, so no
 * network is used: the stub records the URL it was asked for and answers
 * with the status, redirect target and body each case sets.
 *
 * Run: node scripts/test-monitor-trigger.ts
 */
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

/** The `run: |` block of the workflow's trigger step, dedented. */
function triggerScript(): string {
  const wf = readFileSync(new URL("../.github/workflows/run-monitors.yml", import.meta.url), "utf8");
  const lines = wf.split("\n");
  const start = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  if (start < 0) throw new Error("no run: | block in run-monitors.yml");
  const body: string[] = [];
  let indent = -1;
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === "") { body.push(""); continue; }
    const n = l.length - l.trimStart().length;
    if (indent < 0) indent = n;
    if (n < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

const dir = mkdtempSync(join(tmpdir(), "trigger-"));
const stub = join(dir, "curl");
// Stub curl: logs every argument, writes FAKE_BODY to the -o file and prints
// the -w format with FAKE_STATUS and FAKE_REDIRECT filled in.
writeFileSync(
  stub,
  `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CURL_LOG"
out=""; fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) fmt="$2"; shift ;;
  esac
  shift
done
[ -n "$out" ] && printf '%s' "$FAKE_BODY" > "$out"
fmt="\${fmt//%\\{http_code\\}/$FAKE_STATUS}"
fmt="\${fmt//%\\{redirect_url\\}/$FAKE_REDIRECT}"
printf '%s' "$fmt"
`,
);
chmodSync(stub, 0o755);
const script = triggerScript();
const SECRET = "test-secret-value-1234";

function run(prelaunchUrl: string, status: string, redirect = "", body = "{}") {
  const log = join(dir, "curl.log");
  rmSync(log, { force: true });
  const r = spawnSync("bash", ["-e", "-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CRON_SECRET: SECRET,
      PRELAUNCH_URL: prelaunchUrl,
      CURL_LOG: log,
      FAKE_STATUS: status,
      FAKE_REDIRECT: redirect,
      FAKE_BODY: body,
    },
  });
  let args: string[] = [];
  try { args = readFileSync(log, "utf8").trim().split("\n"); } catch { /* curl not called */ }
  const url = args[args.length - 1] ?? "";
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), args, url };
}

let r = run("https://app.example.com/", "200", "", '{"started":1}');
check("https URL: calls the endpoint as given (trailing slash dropped)", r.url === "https://app.example.com/api/cron/run-monitors", r.url);
check("https URL: 200 passes", r.code === 0, r.out);
check("https URL: logs the summary", r.out.includes('{"started":1}'), r.out);
check("never follows redirects (no -L / --location)", !r.args.some((a) => a === "-L" || a.startsWith("--location")), r.args.join(" "));

r = run("http://app.example.com", "200");
check("http URL: upgraded to https", r.url === "https://app.example.com/api/cron/run-monitors", r.url);
check("http URL: warns to fix the setting", r.out.includes("::warning::PRELAUNCH_URL starts with http://"), r.out);
check("http URL: passes once upgraded", r.code === 0, r.out);

r = run("app.example.com", "200");
check("scheme-less URL: https added", r.url === "https://app.example.com/api/cron/run-monitors", r.url);
check("scheme-less URL: warns to fix the setting", r.out.includes("::warning::PRELAUNCH_URL has no scheme"), r.out);

r = run("ftp://app.example.com", "200");
check("other scheme: fails without calling", r.code === 1 && r.args.length === 0, r.out);

r = run("http://localhost:3000", "200");
check("local http kept for testing", r.url === "http://localhost:3000/api/cron/run-monitors", r.url);

r = run("https://app.example.com", "308", "https://www.app.example.com/api/cron/run-monitors?x=1");
check("308: fails", r.code === 1, r.out);
check("308: names only the redirect's scheme and host", r.out.includes("redirects (HTTP 308) to https://www.app.example.com;") && !r.out.includes("?x=1"), r.out);

r = run("https://app.example.com", "403", "", "cron auth required");
check("403: fails", r.code === 1 && r.out.includes("returned HTTP 403"), r.out);

for (const [u, s, red] of [["http://app.example.com", "308", "https://app.example.com/x"], ["https://app.example.com", "500", ""]] as const) {
  r = run(u, s, red);
  check(`HTTP ${s}: output never shows CRON_SECRET`, !r.out.includes(SECRET), r.out);
}

r = run("", "200");
check("unset URL: skips with a warning", r.code === 0 && r.args.length === 0 && r.out.includes("PRELAUNCH_URL"), r.out);

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`${failures} FAILED (test-monitor-trigger)`);
  process.exit(1);
}
console.log("ALL PASS (test-monitor-trigger)");
