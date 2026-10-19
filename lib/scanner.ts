/**
 * Scan runner: parallel execution with per-check timeouts, plus grading.
 *
 * Grading (from the MVP spec): 100-point scale, start at 100 and subtract
 * per finding — blocker −15, warning −5, info −1, floored at 0.
 * Bands: A+ 95+, A 90+, B 80+, C 70+, D 60+, F below.
 * A report with zero blockers earns the "Ready to launch" banner.
 */

import type { Check, Finding, ScanContext, ScanMode, ScanResult } from "./checks/types.ts";
import { registry } from "./checks/index.ts";
import { assertSafeHostname } from "./ssrf.ts";

export const CHECK_TIMEOUT_MS = 15_000;
export const TOTAL_BUDGET_MS = 45_000;

const SEVERITY_PENALTY: Record<Finding["severity"], number> = {
  blocker: 15,
  warning: 5,
  info: 1,
};

export function grade(findings: Finding[]): { score: number; grade: string } {
  let score = 100;
  for (const f of findings) score -= SEVERITY_PENALTY[f.severity];
  score = Math.max(0, score);
  const grade =
    score >= 95 ? "A+" :
    score >= 90 ? "A" :
    score >= 80 ? "B" :
    score >= 70 ? "C" :
    score >= 60 ? "D" : "F";
  return { score, grade };
}

export function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http(s) URLs are supported");
  }
  parsed.hash = "";
  return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname);
}

async function runOne(
  check: Check,
  ctx: ScanContext,
): Promise<{ findings: Finding[]; ms: number }> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const findings = await Promise.race([
      check.run(ctx),
      new Promise<Finding[]>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`check timeout: ${check.id}`)),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]).catch((err) => [
      {
        checkId: check.id,
        severity: "info" as const,
        title: `Check failed to complete: ${String((err as Error).message ?? err)}`,
        location: ctx.target,
        fix: "Re-run the scan; if it persists, the target may be blocking automated requests.",
      },
    ]);
    return { findings, ms: Date.now() - start };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runScan(
  rawUrl: string,
  mode: ScanMode,
  id: string,
): Promise<ScanResult> {
  const target = normalizeUrl(rawUrl);
  // Fail fast on SSRF targets (loopback/metadata/private). Every individual
  // request is re-validated in cachedGet too; this gives a clean early error.
  await assertSafeHostname(new URL(target).hostname);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const ctx: ScanContext = { target, mode, cache: new Map() };

  const eligible = registry.filter((c) => c.modes.includes(mode));
  const results = await Promise.all(eligible.map((c) => runOne(c, ctx)));

  const findings = results.flatMap((r) => r.findings);
  const checkTimings: Record<string, number> = {};
  eligible.forEach((c, i) => {
    checkTimings[c.id] = results[i].ms;
  });

  // Deterministic order: blockers first, then warnings, then info.
  const rank = { blocker: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.checkId.localeCompare(b.checkId));

  const { score, grade: gradeLetter } = grade(findings);
  const finishedMs = Date.now();

  return {
    id,
    url: target,
    mode,
    status: "done",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: finishedMs - startedMs,
    score,
    grade: gradeLetter,
    findings,
    checkTimings,
  };
}
