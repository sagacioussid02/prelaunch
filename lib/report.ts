/**
 * Shareable report renderer.
 * Pure function: ScanResult → HTML. `renderReportBody` returns a styled fragment
 * (used by the Next.js /r/[id] route, with client-side effects layered on top);
 * `renderReport` wraps it in a standalone document for the CLI and tests.
 */

import type { CheckProgress, Finding, ScanResult } from "./checks/types.ts";
import { metaFor } from "./checks/meta.ts";

const GRADE_COLORS: Record<string, string> = {
  "A+": "#22c55e",
  A: "#4ade80",
  B: "#a3e635",
  C: "#facc15",
  D: "#fb923c",
  F: "#f87171",
};

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  blocker: "Blockers",
  warning: "Warnings",
  info: "Info",
};

const SEVERITY_BLURB: Record<Finding["severity"], string> = {
  blocker: "Fix these before you launch. Each costs 15 points.",
  warning: "Worth fixing soon. Each costs 5 points.",
  info: "Nice-to-haves. Each costs 1 point.",
};

const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  blocker: "#f87171",
  warning: "#fbbf24",
  info: "#60a5fa",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const REPORT_CSS = `
.pl{--card:#121a24;--card2:#0f1620;--line:#1f2b3a;--text:#e8edf2;--muted:#8fa1b5;--accent:var(--grade,#4ade80);
  max-width:980px;margin:0 auto;padding:32px 16px 80px;color:var(--text);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.pl *{box-sizing:border-box}
.pl a{color:#7cb7ff}
.pl h2{font-size:20px;margin:48px 0 6px;display:flex;align-items:center;gap:10px}
.pl .sub{color:var(--muted);margin:0 0 18px;font-size:14px;line-height:1.5}
.pl .count{background:#1b2735;border-radius:999px;padding:2px 10px;font-size:13px;color:var(--muted)}

@keyframes pl-rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes pl-ring{from{stroke-dashoffset:339.3}}
@keyframes pl-glow{0%,100%{opacity:.55}50%{opacity:.9}}
@keyframes pl-pop{0%{transform:scale(.4);opacity:0}70%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
.pl .rise{animation:pl-rise .6s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0)*55ms)}

.pl-stage{perspective:1100px}
.pl-hero{position:relative;border-radius:24px;padding:36px 24px;text-align:center;overflow:hidden;
  background:linear-gradient(160deg,#142033,#0d141d);border:1px solid var(--line);
  transform-style:preserve-3d;transform:rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));transition:transform .18s ease-out;
  box-shadow:0 30px 80px -30px color-mix(in srgb,var(--accent) 45%,transparent)}
.pl-hero::before{content:"";position:absolute;inset:-40% -10% auto;height:80%;pointer-events:none;
  background:radial-gradient(closest-side,color-mix(in srgb,var(--accent) 35%,transparent),transparent);animation:pl-glow 4s ease-in-out infinite}
.pl-ring{position:relative;width:190px;height:190px;margin:0 auto;transform:translateZ(50px)}
.pl-ring svg{width:100%;height:100%;transform:rotate(-90deg)}
.pl-ring .bg{stroke:#223146}
.pl-ring .fg{stroke:var(--accent);stroke-linecap:round;stroke-dasharray:339.3;animation:pl-ring 1.4s cubic-bezier(.2,.8,.2,1) both;
  filter:drop-shadow(0 0 8px var(--accent))}
.pl-ring .num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.pl-ring .score{font-size:56px;font-weight:800;line-height:1}
.pl-ring .of{font-size:12px;color:var(--muted);margin-top:2px}
.pl-grade{display:inline-block;margin-top:14px;font-size:20px;font-weight:800;color:#06130a;background:var(--accent);
  border-radius:10px;padding:4px 16px;animation:pl-pop .6s .8s both;transform:translateZ(40px)}
.pl-target{margin-top:12px;color:var(--muted);word-break:break-all;font-size:14px}
.pl-verdict{position:relative;margin:18px auto 0;max-width:520px;border-radius:12px;padding:12px 16px;font-weight:600;font-size:15px}
.pl-verdict.ok{background:#0f2a1a;color:#86efac;border:1px solid #14532d}
.pl-verdict.bad{background:#2d1414;color:#fca5a5;border:1px solid #7f1d1d}
.pl-chips{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px;position:relative}
.pl-chip{background:#0d1520;border:1px solid var(--line);border-radius:12px;padding:8px 14px;font-size:13px;color:var(--muted)}
.pl-chip b{display:block;font-size:22px;color:var(--text)}

.pl-guide{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.pl-guide div{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;font-size:14px;color:var(--muted);line-height:1.5}
.pl-guide b{display:block;margin-bottom:4px;font-size:15px}

.pl-tilt{transform:perspective(800px) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg)) translateZ(0);transition:transform .18s ease-out,box-shadow .2s}
.pl-tilt:hover{box-shadow:0 18px 40px -18px rgba(0,0,0,.7)}

.pl-devices{display:flex;gap:28px;align-items:flex-end;justify-content:center;flex-wrap:wrap;perspective:1500px;padding:18px 0}
.pl-dev{transition:transform .6s cubic-bezier(.2,.8,.2,1);transform-style:preserve-3d}
.pl-dev:hover{transform:rotateY(0) translateY(-8px) scale(1.02)!important}
.pl-dev figcaption{text-align:center;color:var(--muted);font-size:12px;margin-top:10px}
.pl-dev.desktop{width:min(560px,100%);transform:rotateY(9deg)}
.pl-dev.tablet{width:190px;transform:rotateY(-7deg)}
.pl-dev.mobile{width:112px;transform:rotateY(-14deg)}
.pl-frame{background:#0a0f16;border:1px solid #2a3a4f;border-radius:12px;overflow:hidden;box-shadow:0 30px 50px -25px rgba(0,0,0,.9)}
.pl-dev.tablet .pl-frame,.pl-dev.mobile .pl-frame{border-width:5px;border-radius:20px}
.pl-bar{display:flex;gap:6px;padding:8px 10px;background:#121c29}
.pl-bar i{width:9px;height:9px;border-radius:50%;background:#334559;display:block}
.pl-frame img{display:block;width:100%;height:auto}

.pl-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
.pl-check{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.pl-check-head{display:flex;gap:10px;align-items:center;font-weight:600}
.pl-ico{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:800;color:#06130a}
.pl-check p{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.5}
.pl-check details{margin-top:8px;font-size:13px;color:var(--muted)}
.pl-check summary{cursor:pointer;color:#7cb7ff}
.pl-cat{grid-column:1/-1;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:10px 0 -4px}

.pl-f{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--c);border-radius:14px;padding:16px 18px;margin-bottom:12px}
.pl-f-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.pl-sev{color:#0b0f14;background:var(--c);font-size:11px;font-weight:800;text-transform:uppercase;border-radius:6px;padding:2px 8px}
.pl-f-title{font-weight:650}
.pl-f-loc{margin-top:8px;font-size:12px;color:var(--muted);word-break:break-all;font-family:ui-monospace,monospace}
.pl-f-why,.pl-f-fix{margin-top:10px;font-size:14px;line-height:1.5;color:#c3cfdc}
.pl-f-why b{color:#e8edf2}
.pl-f-fix{background:#0d1520;border-radius:10px;padding:10px 12px}
.pl-empty{text-align:center;color:#86efac;font-weight:600;margin:32px 0}

.pl-actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:32px}
.pl-btn2{background:#1b2735;color:#e8edf2!important;border:1px solid var(--line)}
.pl-plan{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.pl-step{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:start;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.pl-gain{color:#0b0f14;font-weight:800;border-radius:8px;padding:4px 10px;font-size:14px}
.pl-after{color:var(--muted);font-size:13px;white-space:nowrap;padding-top:4px}
@media print{.pl-actions,#monitor-slot{display:none}.pl *{animation:none!important}}
.pl-btn{display:inline-block;padding:12px 24px;border-radius:12px;font-weight:700;text-decoration:none;background:#e8edf2;color:#0b0f14!important}
.pl-cta{margin-top:40px;background:linear-gradient(160deg,#142033,#0d141d);border:1px solid var(--line);border-radius:20px;padding:26px;text-align:center}
.pl-meta{margin-top:32px;font-size:12px;color:#5f7186;text-align:center}
@media (prefers-reduced-motion:reduce){.pl *,.pl *::before{animation:none!important;transition:none!important}}
`;

function checkCard(p: CheckProgress, i: number): string {
  const meta = metaFor(p.id);
  const n = p.findingCount ?? 0;
  const color = n === 0 ? "#4ade80" : SEVERITY_COLOR[p.worst ?? "info"];
  const icon = n === 0 ? "✓" : String(n);
  const label = n === 0 ? "Clean" : `${n} issue${n > 1 ? "s" : ""}`;
  return `
  <div class="pl-check pl-tilt rise" style="--i:${i}">
    <div class="pl-check-head"><span class="pl-ico" style="background:${color}">${icon}</span>
      <span>${esc(p.name)}</span><span class="count" style="margin-left:auto">${label}</span></div>
    <p>${esc(meta.looksFor)}</p>
    <details><summary>Why it matters</summary><p>${esc(meta.why)}</p></details>
  </div>`;
}

function findingCard(f: Finding, i: number): string {
  const why = metaFor(f.checkId).why;
  return `
  <div class="pl-f rise" style="--c:${SEVERITY_COLOR[f.severity]};--i:${i}">
    <div class="pl-f-head">
      <span class="pl-sev">${f.severity}</span>
      <span class="pl-f-title">${esc(f.title)}</span>
    </div>
    <div class="pl-f-loc">${esc(f.location)}</div>
    <div class="pl-f-why"><b>Why it matters:</b> ${esc(why)}</div>
    <div class="pl-f-fix"><b>How to fix:</b> ${esc(f.fix)}${f.fixLink ? ` <a href="${esc(f.fixLink)}" target="_blank" rel="noopener">Read more →</a>` : ""}</div>
  </div>`;
}

const PENALTY: Record<Finding["severity"], number> = { blocker: 15, warning: 5, info: 1 };
const TARGET_SCORE = 70;

/** Shortest fix list (biggest point gains first) that lifts a failing score to TARGET_SCORE. */
function improvementPlan(result: ScanResult): string {
  if (result.score >= TARGET_SCORE || result.findings.length === 0) return "";
  const ranked = [...result.findings].sort((a, b) => PENALTY[b.severity] - PENALTY[a.severity]);
  const steps: Array<{ f: Finding; after: number }> = [];
  let score = result.score;
  for (const f of ranked) {
    score = Math.min(100, score + PENALTY[f.severity]);
    steps.push({ f, after: score });
    if (score >= TARGET_SCORE) break;
  }
  const reached = score >= TARGET_SCORE;
  const rows = steps
    .map(
      ({ f, after }, i) => `
    <li class="pl-step rise" style="--i:${i}">
      <span class="pl-gain" style="background:${SEVERITY_COLOR[f.severity]}">+${PENALTY[f.severity]}</span>
      <div><div class="pl-f-title">${esc(f.title)}</div>
        <div class="pl-f-fix" style="margin-top:6px">${esc(f.fix)}</div></div>
      <span class="pl-after">→ ${after}</span>
    </li>`,
    )
    .join("");
  return `
  <h2>How to improve your grade</h2>
  <p class="sub">${
    reached
      ? `Your score is ${result.score}. Fixing these ${steps.length} item${steps.length > 1 ? "s" : ""}, in this order, lifts it to ${score} (grade C or better). They are ranked by points gained, so the first fixes matter most.`
      : `Your score is ${result.score}. Fixing everything below gets you to ${score}; no single area is enough on its own.`
  }</p>
  <ol class="pl-plan">${rows}</ol>
  <p class="sub">Then rescan: grades update as soon as the fixes are live. Blockers are worth 15 points each, so clear those before anything else.</p>`;
}

function devices(result: ScanResult, baseUrl: string, inline?: Record<string, string>): string {
  const shots = result.screenshots ?? [];
  if (!shots.length) return "";
  const figs = shots
    .map((s) => {
      const bar = s.name === "desktop" ? `<div class="pl-bar"><i></i><i></i><i></i></div>` : "";
      return `<figure class="pl-dev ${s.name}" style="margin:0">
        <div class="pl-frame">${bar}<img src="${inline?.[s.name] ?? `${esc(baseUrl)}/api/shot/${esc(result.id)}/${esc(s.name)}.jpg`}" alt="${esc(s.label)} screenshot" loading="lazy"></div>
        <figcaption>${esc(s.label)}</figcaption></figure>`;
    })
    .join("");
  return `
  <h2>What your visitors see</h2>
  <p class="sub">Screenshots taken by a real Chrome browser while the live simulations ran. Hover to straighten.</p>
  <div class="pl-devices rise">${figs}</div>`;
}

export function renderReportBody(
  result: ScanResult,
  opts: { baseUrl: string; monitorSlot?: boolean; inlineShots?: Record<string, string>; downloads?: boolean },
): string {
  const color = GRADE_COLORS[result.grade] ?? "#9ca3af";
  const by = (s: Finding["severity"]) => result.findings.filter((f) => f.severity === s);
  const blockers = by("blocker");
  const groups: Array<Finding["severity"]> = ["blocker", "warning", "info"];
  const ring = Math.round(339.3 * (1 - result.score / 100) * 10) / 10;

  let idx = 0;
  const sections = groups
    .map((sev) => {
      const list = by(sev);
      if (!list.length) return "";
      return `
      <h2><span style="color:${SEVERITY_COLOR[sev]}">●</span> ${SEVERITY_LABEL[sev]} <span class="count">${list.length}</span></h2>
      <p class="sub">${SEVERITY_BLURB[sev]}</p>
      ${list.map((f) => findingCard(f, idx++)).join("\n")}`;
    })
    .join("\n");

  const progress = result.progress ?? [];
  let lastCat = "";
  const checks = progress
    .map((p, i) => {
      const head = p.category !== lastCat ? `<div class="pl-cat">${esc(p.category)}</div>` : "";
      lastCat = p.category;
      return head + checkCard(p, i);
    })
    .join("");

  const verdict =
    blockers.length === 0
      ? `<div class="pl-verdict ok">Ready to launch 🚀 — no blockers found.</div>`
      : `<div class="pl-verdict bad">${blockers.length} blocker${blockers.length > 1 ? "s" : ""} to fix before launch.</div>`;

  const date = new Date(result.finishedAt ?? result.startedAt).toLocaleString();

  const cta = opts.monitorSlot
    ? `<div id="monitor-slot"></div>`
    : `<div class="pl-cta"><div style="font-weight:700;font-size:18px">Monitor every deploy</div>
       <div style="color:#8fa1b5;font-size:14px;margin-top:4px">Enable it from the web app: ${esc(opts.baseUrl)}/r/${esc(result.id)}</div></div>`;

  return `<style>${REPORT_CSS}</style>
<div class="pl" style="--grade:${color}">
  <div class="pl-stage"><div class="pl-hero" data-tilt>
    <div class="pl-ring">
      <svg viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="54" fill="none" stroke-width="9"/>
        <circle class="fg" cx="60" cy="60" r="54" fill="none" stroke-width="9" style="stroke-dashoffset:${ring}"/></svg>
      <div class="num"><span class="score" data-count="${result.score}">${result.score}</span><span class="of">out of 100</span></div>
    </div>
    <span class="pl-grade">Grade ${esc(result.grade)}</span>
    <div class="pl-target">${esc(result.url)}</div>
    ${verdict}
    <div class="pl-chips">
      <div class="pl-chip"><b style="color:${SEVERITY_COLOR.blocker}">${blockers.length}</b>blockers</div>
      <div class="pl-chip"><b style="color:${SEVERITY_COLOR.warning}">${by("warning").length}</b>warnings</div>
      <div class="pl-chip"><b style="color:${SEVERITY_COLOR.info}">${by("info").length}</b>info</div>
      <div class="pl-chip"><b>${progress.length}</b>checks run</div>
    </div>
  </div></div>

  ${improvementPlan(result)}

  <h2>How to read this report</h2>
  <div class="pl-guide">
    <div class="rise"><b>Score</b>Starts at 100. Every finding subtracts points based on how serious it is.</div>
    <div class="rise" style="--i:1"><b>Grade</b>A+ is 95 and up, A 90, B 80, C 70, D 60. Below that is an F.</div>
    <div class="rise" style="--i:2"><b>Blockers</b>Security or breakage issues. Don&rsquo;t launch with these open.</div>
    <div class="rise" style="--i:3"><b>Warnings &amp; info</b>Quality, performance and polish. Fix as time allows.</div>
  </div>

  ${devices(result, opts.baseUrl, opts.inlineShots)}

  ${progress.length ? `<h2>What we checked</h2>
  <p class="sub">${progress.length} automated checks looked at your live site. Each card says what it looks for and why that matters.</p>
  <div class="pl-checks">${checks}</div>` : ""}

  <h2>Your findings</h2>
  ${result.findings.length === 0 ? `<p class="pl-empty">No issues found. Ship it. 🚀</p>` : sections}

  <div class="pl-actions"><a class="pl-btn" href="${esc(opts.baseUrl)}/">↻ Scan another site</a>${
    opts.downloads
      ? `<a class="pl-btn pl-btn2" href="${esc(opts.baseUrl)}/api/report/${esc(result.id)}" download>⬇ Download report (HTML)</a><a class="pl-btn pl-btn2" href="${esc(opts.baseUrl)}/api/report/${esc(result.id)}?format=json" download>⬇ JSON</a>`
      : ""
  }</div>
  ${cta}

  <div class="pl-meta">
    Scanned ${esc(result.url)} · ${esc(date)} · ${result.durationMs ?? "?"}ms · mode: ${esc(result.mode)} · PreLaunch Check prototype
  </div>
</div>`;
}

export function renderReport(
  result: ScanResult,
  opts: { baseUrl: string; inlineShots?: Record<string, string> },
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PreLaunch Check — ${esc(result.grade)} (${result.score}) · ${esc(result.url)}</title>
<style>body{margin:0;background:#0b0f14}</style>
</head>
<body>
${renderReportBody(result, opts)}
</body>
</html>`;
}

/** Shields.io-style score badge SVG for README/launch-post embedding. */
export function renderBadge(result: ScanResult): string {
  const color = GRADE_COLORS[result.grade] ?? "#6b7280";
  const label = `prelaunch ${result.grade}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${20 + label.length * 7}" height="20">
  <rect width="100%" height="20" rx="4" fill="${color}"/>
  <text x="10" y="14" font-family="Verdana,sans-serif" font-size="11" fill="#062813" font-weight="bold">${label}</text>
</svg>`;
}
