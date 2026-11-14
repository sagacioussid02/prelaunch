// Prelaunch GitHub Action entry point. Runs on GitHub's node24 runtime with
// no dependencies: inputs from INPUT_* env vars, outputs and the job
// summary via the GITHUB_OUTPUT / GITHUB_STEP_SUMMARY files, GitHub's REST
// API through fetch.
import { appendFileSync, readFileSync } from "node:fs";
import {
  COMMENT_MARKER,
  looksLikeProtectedVercel,
  parseFailOn,
  prNumberFromEvent,
  renderSummary,
  resolveTarget,
  retryDelaySeconds,
  shaFromEvent,
  startErrorMessage,
} from "./lib.mjs";

const OIDC_AUDIENCE = "prelaunch";
const POLL_MS = Number(process.env.PRELAUNCH_ACTION_POLL_MS) || 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
const escapeCmd = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const log = {
  info: (m) => console.log(m),
  notice: (m) => console.log(`::notice::${escapeCmd(m)}`),
  warning: (m) => console.log(`::warning::${escapeCmd(m)}`),
  error: (m) => console.log(`::error::${escapeCmd(m)}`),
};

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const line = `${name}=${String(value).replace(/[\r\n]+/g, " ")}\n`;
  if (file) appendFileSync(file, line);
  else console.log(`output ${line.trim()}`);
}

function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

async function githubOidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) return null;
  const u = new URL(url);
  u.searchParams.set("audience", OIDC_AUDIENCE);
  const res = await fetch(u, { headers: { Authorization: `bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`GitHub OIDC token request failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.value) throw new Error("GitHub OIDC token request returned no token");
  console.log(`::add-mask::${body.value}`);
  return body.value;
}

function gh(token) {
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  return async (method, path, body) => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
}

async function findPrNumber(api, repo, ctx) {
  const direct = prNumberFromEvent(ctx);
  if (direct) return direct;
  const sha = shaFromEvent(ctx);
  if (!sha) return null;
  const pulls = await api("GET", `/repos/${repo}/commits/${sha}/pulls`);
  const open = (pulls ?? []).filter((p) => p.state === "open");
  return (open.find((p) => p.head?.sha === sha) ?? open[0])?.number ?? null;
}

async function upsertComment(api, repo, pr, markdown) {
  let existing = null;
  for (let page = 1; page <= 5 && !existing; page++) {
    const comments = await api("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    existing = (comments ?? []).find((c) => typeof c.body === "string" && c.body.startsWith(COMMENT_MARKER)) ?? null;
    if (!comments || comments.length < 100) break;
  }
  if (existing) {
    try {
      await api("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body: markdown });
      return "updated";
    } catch {
      // Not ours to edit (e.g. posted with another token): post a fresh one.
    }
  }
  await api("POST", `/repos/${repo}/issues/${pr}/comments`, { body: markdown });
  return "posted";
}

async function startScan(base, credential, url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}/api/ci/scan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    const wait = retryDelaySeconds(res.status, res.headers.get("retry-after"));
    if (wait !== null && attempt < 3) {
      log.info(`Prelaunch is busy (HTTP ${res.status}); retrying in ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(startErrorMessage(res.status, text));
  }
}

async function waitForScan(base, statusPath, deadline) {
  while (Date.now() < deadline) {
    const res = await fetch(`${base}${statusPath}`, { headers: { "Cache-Control": "no-store" } });
    if (res.ok) {
      const s = await res.json();
      if (s.status === "done") return s;
      if (s.status === "failed") throw new Error(`the scan failed: ${s.error ?? "no reason given"}`);
      const running = (s.progress ?? []).filter((p) => p.status === "running").map((p) => p.name);
      if (running.length) log.info(`scanning: ${running.join(", ")}`);
    } else if (res.status !== 404) {
      log.info(`status check returned HTTP ${res.status}; retrying`);
    }
    await sleep(POLL_MS);
  }
  throw new Error("timed out waiting for the scan; raise timeout-minutes or try again");
}

async function run() {
  const failOn = parseFailOn(input("fail-on"));
  const base = (input("prelaunch-url") || "https://prelaunch-check.vercel.app").replace(/\/$/, "");
  const timeoutMin = Math.min(30, Math.max(1, Number(input("timeout-minutes")) || 6));
  const ctx = {
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    event: readEvent(),
    envSha: process.env.GITHUB_SHA,
  };

  const target = resolveTarget({ inputUrl: input("url"), ...ctx });
  if (target.skip) {
    log.notice(`Prelaunch skipped: ${target.skip}`);
    return 0;
  }
  if (target.error) throw new Error(target.error);

  let credential = input("api-key");
  if (!credential) {
    credential = await githubOidcToken();
    if (!credential) {
      throw new Error(
        'no credentials: add "permissions: id-token: write" to the job (public repositories, free) or pass a Prelaunch key as api-key',
      );
    }
  }

  try {
    const probe = await fetch(target.url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (looksLikeProtectedVercel(probe.status, probe.headers)) {
      throw new Error(
        `${target.url} is behind Vercel Deployment Protection, so the scanner would only see a login page. Turn protection off for previews or scan a public URL.`,
      );
    }
  } catch (err) {
    if (String(err?.message).includes("Deployment Protection")) throw err;
    // Unreachable from the runner: let Prelaunch try and report what it sees.
  }

  log.info(`Prelaunch: scanning ${target.url}`);
  const started = await startScan(base, credential, target.url);
  const reportUrl = `${base}${started.reportUrl ?? `/r/${started.id}`}`;
  setOutput("scan-id", started.id);
  setOutput("report-url", reportUrl);
  log.info(`report: ${reportUrl}`);

  await waitForScan(base, started.statusUrl ?? `/api/scan/${started.id}`, Date.now() + timeoutMin * 60_000);
  const res = await fetch(`${base}${started.resultUrl ?? `/api/report/${started.id}?format=json`}`);
  if (!res.ok) throw new Error(`could not read the scan result: HTTP ${res.status}`);
  const result = await res.json();

  const summary = renderSummary({ result, reportUrl, failOn });
  setOutput("grade", result.grade);
  setOutput("score", result.score);
  setOutput("blockers", summary.counts.blocker);
  setOutput("warnings", summary.counts.warning);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.markdown + "\n");
  log.info(
    `grade ${result.grade} (${result.score}/100): ${summary.counts.blocker} blockers, ${summary.counts.warning} warnings`,
  );

  const token = input("github-token");
  const repo = process.env.GITHUB_REPOSITORY;
  if (input("comment") !== "false" && token && repo) {
    try {
      const api = gh(token);
      const pr = await findPrNumber(api, repo, ctx);
      if (pr) log.info(`PR #${pr}: comment ${await upsertComment(api, repo, pr, summary.markdown)}`);
      else log.info("no open pull request for this commit; skipped the comment");
    } catch (err) {
      log.warning(`could not comment on the pull request (${err.message}); give the job "pull-requests: write"`);
    }
  }

  if (summary.failed) {
    const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
    log.error(
      failOn === "warning"
        ? `Prelaunch found ${n(summary.counts.blocker, "blocker")} and ${n(summary.counts.warning, "warning")}`
        : `Prelaunch found ${n(summary.counts.blocker, "launch blocker")}`,
    );
    return 1;
  }
  return 0;
}

let failOnForErrors = "blocker";
try {
  failOnForErrors = parseFailOn(input("fail-on"));
} catch {
  /* run() reports it */
}
run().then(
  (code) => process.exit(code),
  (err) => {
    if (failOnForErrors === "never") {
      log.warning(`Prelaunch: ${err.message}`);
      process.exit(0);
    }
    log.error(`Prelaunch: ${err.message}`);
    process.exit(1);
  },
);
