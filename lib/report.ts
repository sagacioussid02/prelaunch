/**
 * Shareable report page renderer.
 * Pure function: ScanResult → standalone HTML (inline CSS, mobile-first).
 * Used by the Next.js /r/[id] route and by the CLI test harness.
 */

import type { Finding, ScanResult } from "./checks/types.ts";

const GRADE_COLORS: Record<string, string> = {
  "A+": "#16a34a",
  A: "#22c55e",
  B: "#84cc16",
  C: "#eab308",
  D: "#f97316",
  F: "#ef4444",
};

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  blocker: "Blockers",
  warning: "Warnings",
  info: "Info",
};

const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  blocker: "#ef4444",
  warning: "#f59e0b",
  info: "#3b82f6",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findingCard(f: Finding): string {
  return `
  <div class="finding" style="border-left-color:${SEVERITY_COLOR[f.severity]}">
    <div class="finding-head">
      <span class="sev" style="background:${SEVERITY_COLOR[f.severity]}">${f.severity}</span>
      <span class="finding-title">${esc(f.title)}</span>
    </div>
    <div class="finding-loc">${esc(f.location)}</div>
    <div class="finding-fix"><strong>Fix:</strong> ${esc(f.fix)}
    ${f.fixLink ? `<br><a href="${esc(f.fixLink)}" target="_blank" rel="noopener">How to fix →</a>` : ""}
    </div>
  </div>`;
}

export function renderReport(result: ScanResult, opts: { baseUrl: string }): string {
  const color = GRADE_COLORS[result.grade] ?? "#6b7280";
  const blockers = result.findings.filter((f) => f.severity === "blocker");
  const groups: Array<Finding["severity"]> = ["blocker", "warning", "info"];

  const sections = groups
    .map((sev) => {
      const list = result.findings.filter((f) => f.severity === sev);
      if (!list.length) return "";
      return `
      <section>
        <h2>${SEVERITY_LABEL[sev]} <span class="count">${list.length}</span></h2>
        ${list.map(findingCard).join("\n")}
      </section>`;
    })
    .join("\n");

  const readyBanner =
    blockers.length === 0
      ? `<div class="ready">Ready to launch 🚀 — no blockers found.</div>`
      : `<div class="not-ready">${blockers.length} blocker${blockers.length > 1 ? "s" : ""} to fix before launch.</div>`;

  const date = new Date(result.finishedAt ?? result.startedAt).toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PreLaunch Check — ${result.grade} (${result.score}) · ${esc(result.url)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; background: #f8fafc; color: #0f172a; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
  .hero { background: #fff; border-radius: 16px; padding: 32px 24px; text-align: center;
          box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .score { font-size: 72px; font-weight: 800; color: ${color}; line-height: 1; }
  .grade { display: inline-block; font-size: 20px; font-weight: 700; color: #fff;
           background: ${color}; border-radius: 8px; padding: 4px 14px; margin-top: 8px; }
  .target { margin-top: 12px; color: #475569; word-break: break-all; }
  .ready { margin-top: 16px; background: #dcfce7; color: #166534; border-radius: 10px;
           padding: 12px; font-weight: 600; }
  .not-ready { margin-top: 16px; background: #fee2e2; color: #991b1b; border-radius: 10px;
           padding: 12px; font-weight: 600; }
  h2 { margin: 32px 0 12px; font-size: 18px; }
  .count { background: #e2e8f0; border-radius: 999px; padding: 2px 10px; font-size: 13px; }
  .finding { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 12px;
             border-left: 4px solid; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .finding-head { display: flex; gap: 10px; align-items: baseline; }
  .sev { color: #fff; font-size: 11px; font-weight: 700; text-transform: uppercase;
         border-radius: 6px; padding: 2px 8px; white-space: nowrap; }
  .finding-title { font-weight: 600; }
  .finding-loc { margin-top: 6px; font-size: 12px; color: #64748b; word-break: break-all;
                 font-family: ui-monospace, monospace; }
  .finding-fix { margin-top: 8px; font-size: 14px; color: #334155; }
  .finding-fix a { color: #2563eb; }
  .meta { margin-top: 32px; font-size: 13px; color: #64748b; text-align: center; }
  .actions { display: flex; gap: 12px; justify-content: center; margin-top: 24px; flex-wrap: wrap; }
  .btn { display: inline-block; padding: 12px 24px; border-radius: 10px; font-weight: 600;
         text-decoration: none; }
  .btn-primary { background: #0f172a; color: #fff; }
  .cta { margin-top: 32px; background: #0f172a; color: #fff; border-radius: 16px;
         padding: 24px; text-align: center; }
  .cta input { padding: 10px 14px; border-radius: 8px; border: none; width: min(280px, 80%);
               margin-top: 12px; }
  .cta button { padding: 10px 18px; border-radius: 8px; border: none; background: #22c55e;
                color: #062813; font-weight: 700; margin-top: 12px; cursor: pointer; }
  .empty { text-align: center; color: #16a34a; font-weight: 600; margin: 32px 0; }
  footer { margin-top: 40px; text-align: center; font-size: 12px; color: #94a3b8; }
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <div class="score">${result.score}</div>
    <div><span class="grade">${result.grade}</span></div>
    <div class="target">${esc(result.url)}</div>
    ${readyBanner}
  </div>

  ${result.findings.length === 0
    ? `<p class="empty">No issues found. Ship it. 🚀</p>`
    : sections}

  <div class="actions">
    <a class="btn btn-primary" href="${opts.baseUrl}/">↻ Rescan</a>
  </div>

  <div class="cta">
    <div style="font-weight:700;font-size:18px">Monitor every deploy — coming soon</div>
    <div style="color:#cbd5e1;font-size:14px;margin-top:4px">Auto-audit each production deploy, alert on new blockers.</div>
    <form action="${opts.baseUrl}/api/notify" method="post">
      <input type="email" name="email" placeholder="you@example.com" required>
      <button type="submit">Notify me</button>
    </form>
  </div>

  <div class="meta">
    Scanned ${esc(result.url)} · ${esc(date)} · ${result.durationMs ?? "?"}ms ·
    mode: ${esc(result.mode)} · PreLaunch Check prototype
  </div>
  <footer>PreLaunch Check — one-click pre-launch audit</footer>
</div>
</body>
</html>`;
}

/** Shields.io-style score badge SVG for README/launch-post embedding. */
export function renderBadge(result: ScanResult): string {
  const color = GRADE_COLORS[result.grade] ?? "#6b7280";
  const label = `prelaunch ${result.grade}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${20 + label.length * 7}" height="20">
  <rect width="100%" height="20" rx="4" fill="${color}"/>
  <text x="10" y="14" font-family="Verdana,sans-serif" font-size="11" fill="#fff" font-weight="bold">${label}</text>
</svg>`;
}
