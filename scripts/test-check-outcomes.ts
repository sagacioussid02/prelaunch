/**
 * Check outcomes on the progress list and report: every check shows as
 * passed, found issues, failed (with why) or didn't run (with why), and a
 * partial scan never says "Ready to launch".
 *
 * No network: uses fake checks against runOne and a synthetic result.
 * Run: node scripts/test-check-outcomes.ts
 */

const { runOne, scanProgress, OWNER_ONLY_REASON } = await import("../lib/scanner.ts");
const { registry } = await import("../lib/checks/index.ts");
const { CheckNotRun, checkOutcome } = await import("../lib/checks/types.ts");
const { renderReportBody, outcomeSummary } = await import("../lib/report.ts");
import type { Check, CheckProgress, Finding, ScanContext, ScanResult } from "../lib/checks/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ctx: ScanContext = { target: "https://example.test", mode: "passive", cache: new Map(), scanId: "t", screenshots: [] };
const fake = (run: Check["run"], timeoutMs?: number): Check => ({
  id: "fake", name: "Fake", category: "Test", categoryWeight: 1, modes: ["passive"], run, ...(timeoutMs ? { timeoutMs } : {}),
});
const finding: Finding = { checkId: "fake", severity: "warning", title: "x", location: "y", fix: "z" };

// ---- runOne outcomes ----
{
  const r = await runOne(fake(async () => []), ctx);
  check("runOne: no findings → passed", r.outcome === "passed" && r.reason === undefined);
}
{
  const r = await runOne(fake(async () => [finding]), ctx);
  check("runOne: findings → issues", r.outcome === "issues" && r.findings.length === 1);
}
{
  const r = await runOne(fake(async () => { throw new Error("connection reset"); }), ctx);
  check("runOne: error → failed with the reason", r.outcome === "failed" && r.reason === "connection reset", JSON.stringify(r));
  check("runOne: error still leaves an info finding (grading unchanged)", r.findings.length === 1 && r.findings[0].severity === "info");
}
{
  const r = await runOne(fake(() => new Promise<Finding[]>(() => {}), 50), ctx);
  check("runOne: timeout → failed, reason says it timed out", r.outcome === "failed" && /timed out/.test(r.reason ?? ""), r.reason);
}
{
  const r = await runOne(fake(async () => { throw new CheckNotRun("no browser", [finding]); }), ctx);
  check("runOne: CheckNotRun → not_run with the reason", r.outcome === "not_run" && r.reason === "no browser");
  check("runOne: CheckNotRun keeps its findings", r.findings.length === 1);
}

// ---- progress list ----
{
  const p = scanProgress("passive");
  const ownerOnly = registry.filter((c) => !c.modes.includes("passive")).map((c) => c.id);
  check("scanProgress: lists every registered check", p.length === registry.length, `${p.length} vs ${registry.length}`);
  check(
    "scanProgress: owner-only checks are marked didn't run with a reason",
    ownerOnly.length > 0 &&
      ownerOnly.every((id) => {
        const e = p.find((x) => x.id === id);
        return e?.outcome === "not_run" && e.reason === OWNER_ONLY_REASON;
      }),
  );
  check("scanProgress: passive checks start pending", p.filter((x) => !ownerOnly.includes(x.id)).every((x) => x.status === "pending"));
  check("scanProgress(full): nothing pre-marked", scanProgress("full").every((x) => x.status === "pending"));
}
{
  const old: CheckProgress = { id: "a", name: "A", category: "c", description: "d", status: "done", findingCount: 0 };
  check("checkOutcome: old stored entry without outcome → passed", checkOutcome(old) === "passed");
  check("checkOutcome: old entry with findings → issues", checkOutcome({ ...old, findingCount: 2 }) === "issues");
  check("checkOutcome: unfinished → undefined", checkOutcome({ ...old, status: "running" }) === undefined);
}

// ---- report ----
{
  const progress: CheckProgress[] = [
    { id: "headers", name: "Headers", category: "Security", description: "", status: "done", outcome: "passed", findingCount: 0, ms: 5 },
    { id: "seo", name: "SEO", category: "SEO", description: "", status: "done", outcome: "issues", findingCount: 1, worst: "warning", ms: 5 },
    { id: "errors", name: "Errors", category: "Errors", description: "", status: "done", outcome: "failed", reason: "connection reset", findingCount: 1, ms: 5 },
    { id: "sim-mobile", name: "Mobile", category: "Sim", description: "", status: "done", outcome: "not_run", reason: "The browser couldn't start", findingCount: 0, ms: 5 },
  ];
  const result: ScanResult = {
    id: "r1", url: "https://example.test", mode: "passive", status: "done",
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 10,
    score: 94, grade: "A", findings: [{ ...finding, checkId: "seo" }, { ...finding, checkId: "errors", severity: "info" }],
    checkTimings: {}, progress, partial: "no Chromium",
  };
  const html = renderReportBody(result, { baseUrl: "http://localhost:3000" });
  check("report: failed check shows why", html.includes("Why it failed:</b> connection reset"));
  check("report: not-run check shows why", html.includes("Why it didn&rsquo;t run:</b> The browser couldn") || html.includes("Why it didn't run:</b> The browser couldn"));
  check("report: passed check labelled", html.includes("Passed"));
  check("report: summary line counts each outcome", outcomeSummary(progress) === "1 passed · 1 found issues · 1 failed · 1 didn't run", outcomeSummary(progress));
  check("report: chip counts only checks that ran", html.includes("<b>2</b>of 4 checks ran"));
  check("report: partial result never says ready to launch", !html.includes("Ready to launch"));
  const clean = renderReportBody({ ...result, findings: [] }, { baseUrl: "http://localhost:3000" });
  check("report: no findings but checks missing → no 'Ship it'", !clean.includes("Ship it") && clean.includes("No issues found in the checks that ran"));
}

if (failures) {
  console.log(`${failures} FAILED (test-check-outcomes)`);
  process.exit(1);
}
console.log("ALL PASS (test-check-outcomes)");
