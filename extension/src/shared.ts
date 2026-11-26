/**
 * Types and helpers shared by the service worker and the popup. Kept free
 * of lib/ imports (types aside) so the popup bundle stays small.
 */
import type { CheckOutcome, Finding } from "../../lib/checks/types.ts";

export type Tier = "quick" | "full";

export interface ExtensionCheck {
  id: string;
  name: string;
  category: string;
  looksFor: string;
  outcome: CheckOutcome;
  findings: number;
  worst?: Finding["severity"];
  reason?: string;
}

export interface ExtensionScanResult {
  tier: Tier;
  url: string;
  grade: string;
  score: number;
  /** quick: no blockers and every check ran. full: also a C or better, as on prelaunch-check.vercel.app. */
  ready: boolean;
  summary: { blockers: number; warnings: number; info: number };
  checks: ExtensionCheck[];
  /** Empty on the quick tier: the details are the paid part. */
  findings: Finding[];
  /** Checks that only the full report runs, named so the popup can show what's locked. */
  lockedChecks: Array<{ id: string; name: string }>;
  checkedAt: string;
  durationMs: number;
}

/** The scan target: the tab's origin. Launch checks are per site, not per page. */
export function scanTarget(tabUrl: string): string {
  const u = new URL(tabUrl);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("Open a website (http or https) to scan it.");
  }
  return u.origin;
}

/** Host-permission patterns the scan needs: both schemes, so the HTTPS-enforcement check can probe http://. */
export function originPatterns(target: string): string[] {
  const host = new URL(target).host;
  return [`https://${host}/*`, `http://${host}/*`];
}

/** Markdown export for the full report (paste into a PR or an issue). */
export function toMarkdown(r: ExtensionScanResult): string {
  const lines = [
    `## Prelaunch report for ${r.url}`,
    "",
    `**Grade ${r.grade}** (${r.score}/100) · ${r.summary.blockers} blockers · ${r.summary.warnings} warnings · ${r.summary.info} info · ${r.ready ? "ready to launch" : "not ready yet"}`,
    "",
    `Checked ${r.checkedAt} with Prelaunch for Chrome.`,
    "",
  ];
  if (!r.findings.length) lines.push("No findings.");
  for (const f of r.findings) {
    lines.push(`- **${f.severity}**: ${f.title} (\`${f.location}\`)`);
    lines.push(`  - Fix: ${f.fix}${f.fixLink ? ` ([docs](${f.fixLink}))` : ""}`);
  }
  lines.push("", "| Check | Result |", "| --- | --- |");
  for (const c of r.checks) {
    lines.push(`| ${c.name} | ${c.outcome === "issues" ? `${c.findings} found` : c.outcome.replace("_", " ")} |`);
  }
  return lines.join("\n") + "\n";
}
