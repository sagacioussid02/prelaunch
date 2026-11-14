// Pure helpers for the Prelaunch GitHub Action. No I/O here, so
// scripts/test-ci-action.ts can test them directly.

export const COMMENT_MARKER = "<!-- prelaunch-check -->";
const SEVERITIES = ["blocker", "warning", "info"];

/**
 * Which URL to scan. An explicit input wins. On deployment_status, only a
 * successful deployment is scanned, at its environment URL (Vercel sets it
 * to the preview URL); anything else is skipped, not failed.
 */
export function resolveTarget({ inputUrl, eventName, event }) {
  if (inputUrl && inputUrl.trim()) return { url: inputUrl.trim() };
  if (eventName === "deployment_status") {
    const ds = event?.deployment_status ?? {};
    if (ds.state !== "success") {
      return { skip: `deployment is "${ds.state ?? "unknown"}", not "success"; nothing to scan yet` };
    }
    const url = ds.environment_url || ds.target_url || event?.deployment?.payload?.web_url;
    if (url) return { url };
    return { error: "the deployment has no URL; pass one with the url input" };
  }
  return {
    error:
      'no URL to scan: set the url input, or run on "deployment_status" so the preview URL is picked up',
  };
}

/** PR number straight from the event, when the event carries one. */
export function prNumberFromEvent({ eventName, event }) {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return event?.pull_request?.number ?? event?.number ?? null;
  }
  if (eventName === "issue_comment" && event?.issue?.pull_request) return event.issue.number;
  return null;
}

/** Commit SHA to look up PRs by, for events that don't carry a PR. */
export function shaFromEvent({ eventName, event, envSha }) {
  if (eventName === "deployment_status") return event?.deployment?.sha ?? envSha ?? null;
  return envSha ?? null;
}

export function parseFailOn(raw) {
  const v = String(raw ?? "").trim().toLowerCase() || "blocker";
  if (!["blocker", "warning", "never"].includes(v)) {
    throw new Error(`fail-on must be "blocker", "warning" or "never", got "${raw}"`);
  }
  return v;
}

export function countBySeverity(findings) {
  const counts = { blocker: 0, warning: 0, info: 0 };
  for (const f of findings ?? []) if (f && SEVERITIES.includes(f.severity)) counts[f.severity]++;
  return counts;
}

/** Checks that failed or could not run (older results lack `outcome`). */
export function incompleteChecks(progress) {
  return (progress ?? []).filter(
    (p) => p && p.status === "done" && (p.outcome === "failed" || p.outcome === "not_run"),
  );
}

export function shouldFail(counts, failOn) {
  if (failOn === "never") return false;
  if (failOn === "warning") return counts.blocker + counts.warning > 0;
  return counts.blocker > 0;
}

/**
 * Text that came from the scanned site (titles, locations) goes into a PR
 * comment: keep it on one line, cap it, stop @mentions and HTML/markdown
 * structure from breaking out.
 */
export function sanitize(text, max = 160) {
  let s = String(text ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@​")
    .replace(/([\\`*_[\]|])/g, "\\$1");
}

/** For text shown inside a `code span`: one line, capped, no backticks. Code spans render literally. */
export function sanitizeCode(text, max = 120) {
  let s = String(text ?? "").replace(/[\r\n\t]+/g, " ").replace(/`/g, "'").trim();
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s || "-";
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function renderSummary({ result, reportUrl, failOn }) {
  const counts = countBySeverity(result.findings);
  const incomplete = incompleteChecks(result.progress);
  const failed = shouldFail(counts, failOn);
  const lines = [COMMENT_MARKER];
  const icon = counts.blocker ? "❌" : counts.warning ? "⚠️" : "✅";
  lines.push(`### ${icon} Prelaunch: grade ${sanitize(result.grade, 4)} (${Number(result.score) || 0}/100)`);
  lines.push("");
  lines.push(
    `${plural(counts.blocker, "blocker")}, ${plural(counts.warning, "warning")}, ${counts.info} info on ${sanitize(result.url, 200)}`,
  );
  const blockers = (result.findings ?? []).filter((f) => f.severity === "blocker");
  if (blockers.length) {
    lines.push("", "**Blockers**");
    for (const f of blockers.slice(0, 10)) {
      lines.push(`- **${sanitize(f.title)}** at \`${sanitizeCode(f.location)}\`: ${sanitize(f.fix, 200)}`);
    }
    if (blockers.length > 10) lines.push(`- …and ${blockers.length - 10} more in the report`);
  }
  const warnings = (result.findings ?? []).filter((f) => f.severity === "warning");
  if (warnings.length) {
    lines.push("", "**Warnings**");
    for (const f of warnings.slice(0, 5)) lines.push(`- ${sanitize(f.title)}`);
    if (warnings.length > 5) lines.push(`- …and ${warnings.length - 5} more in the report`);
  }
  if (incomplete.length) {
    lines.push("", `${plural(incomplete.length, "check")} didn't finish, so this grade is partial.`);
  }
  lines.push("", `[Full report](${reportUrl})`);
  lines.push(
    "",
    `<sub>${failed ? `Failing because fail-on is "${failOn}".` : `fail-on: ${failOn}`} · Prelaunch Check</sub>`,
  );
  return { markdown: lines.join("\n"), counts, failed, incomplete: incomplete.length };
}

/** A readable error for a non-2xx answer from POST /api/ci/scan. */
export function startErrorMessage(status, body) {
  const detail = String(body ?? "").slice(0, 300).trim();
  switch (status) {
    case 401:
      return `Prelaunch refused the credentials (${detail}). For a public repository add "permissions: id-token: write" to the job; otherwise pass a Prelaunch key as api-key.`;
    case 402:
      return `Prelaunch needs a paid key for this repository: ${detail}`;
    case 429:
      return `Prelaunch rate limit: ${detail}`;
    default:
      return `Prelaunch could not start the scan (HTTP ${status}): ${detail}`;
  }
}

/** Retry only short waits (server busy); hourly limits fail straight away. */
export function retryDelaySeconds(status, retryAfterHeader) {
  if (status !== 429 && status !== 503) return null;
  const s = Number(retryAfterHeader);
  if (!Number.isFinite(s) || s <= 0) return status === 503 ? 15 : null;
  return s <= 60 ? s : null;
}

/**
 * Vercel Deployment Protection (on for previews by default) answers the
 * scanner with a login page, which would be graded instead of the app.
 * Spot it from the runner first and say so, rather than post a misleading
 * grade.
 */
export function looksLikeProtectedVercel(status, headers) {
  const get = (k) => (typeof headers?.get === "function" ? headers.get(k) : headers?.[k]) ?? "";
  if (!/vercel/i.test(get("server"))) return false;
  if (status === 401 || status === 403) return true;
  if (status >= 300 && status < 400) return /vercel\.com\/(sso|login)/i.test(get("location"));
  return false;
}
