/**
 * Scan runner: parallel execution with per-check timeouts, plus grading.
 *
 * Grading (from the MVP spec): 100-point scale, start at 100 and subtract
 * per finding — blocker −15, warning −5, info −1, floored at 0.
 * Bands: A+ 95+, A 90+, B 80+, C 70+, D 60+, F below.
 * A complete report with zero blockers and a C or better earns the
 * "Ready to launch" banner; a partial one (browser checks unavailable), or a
 * D or F, never does.
 */

import type { Check, CheckOutcome, CheckProgress, Finding, ScanContext, ScanMode, ScanResult } from "./checks/types.ts";
import { CheckNotRun } from "./checks/types.ts";
import { registry } from "./checks/index.ts";
import { closeSession, getBrowserAvailability } from "./checks/browser.ts";
import { metaFor } from "./checks/meta.ts";
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

export interface RunOutcome {
  findings: Finding[];
  ms: number;
  outcome: CheckOutcome;
  reason?: string;
}

/** Runs one check with its timeout and classifies how it ended (exported for tests). */
export async function runOne(check: Check, ctx: ScanContext): Promise<RunOutcome> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const findings = await Promise.race([
      check.run(ctx),
      new Promise<Finding[]>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${Math.round((check.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000)}s`)),
          check.timeoutMs ?? CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return { findings, ms: Date.now() - start, outcome: findings.length ? "issues" : "passed" };
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof CheckNotRun) {
      return { findings: err.findings, ms, outcome: "not_run", reason: err.message };
    }
    const reason = String((err as Error)?.message ?? err);
    return {
      findings: [
        {
          checkId: check.id,
          severity: "info" as const,
          title: `Check failed to complete: ${reason}`,
          location: ctx.target,
          fix: "Re-run the scan; if it persists, the target may be blocking automated requests.",
        },
      ],
      ms,
      outcome: "failed",
      reason,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function initialProgress(mode: ScanMode): CheckProgress[] {
  return registry
    .filter((c) => c.modes.includes(mode))
    .map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      description: metaFor(c.id).looksFor,
      status: "pending" as const,
    }));
}

/** Reason shown for checks that only run in site-owner ("full") scans. */
export const OWNER_ONLY_REASON =
  "Runs only in a site-owner scan (set up through a deploy hook), because it probes the site more deeply.";

/**
 * Progress list for a scan: every check that runs in `mode`, then the
 * checks that don't, already marked "not_run" with the reason, so the
 * report shows what was and wasn't tested.
 */
export function scanProgress(mode: ScanMode): CheckProgress[] {
  const skipped: CheckProgress[] = registry
    .filter((c) => !c.modes.includes(mode))
    .map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      description: metaFor(c.id).looksFor,
      status: "done" as const,
      outcome: "not_run" as const,
      reason: OWNER_ONLY_REASON,
      findingCount: 0,
    }));
  return [...initialProgress(mode), ...skipped];
}

export async function runScan(
  rawUrl: string,
  mode: ScanMode,
  id: string,
  onProgress?: (progress: CheckProgress[]) => void,
): Promise<ScanResult> {
  const target = normalizeUrl(rawUrl);
  // Fail fast on SSRF targets (loopback/metadata/private). Every individual
  // request is re-validated in cachedGet too; this gives a clean early error.
  await assertSafeHostname(new URL(target).hostname);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const ctx: ScanContext = { target, mode, cache: new Map(), scanId: id, screenshots: [] };

  const eligible = registry.filter((c) => c.modes.includes(mode));
  const progress = scanProgress(mode);
  onProgress?.(progress);
  const results = await Promise.all(
    eligible.map(async (c) => {
      const i = progress.findIndex((p) => p.id === c.id);
      progress[i].status = "running";
      onProgress?.(progress);
      const r = await runOne(c, ctx);
      const rank = { blocker: 0, warning: 1, info: 2 } as const;
      progress[i] = {
        ...progress[i],
        status: "done",
        outcome: r.outcome,
        ...(r.reason ? { reason: r.reason } : {}),
        ms: r.ms,
        findingCount: r.findings.length,
        worst: r.findings.sort((a, b) => rank[a.severity] - rank[b.severity])[0]?.severity,
      };
      onProgress?.(progress);
      return r;
    }),
  ).finally(() => closeSession(ctx));

  const findings = results.flatMap((r) => r.findings);
  const checkTimings: Record<string, number> = {};
  eligible.forEach((c, i) => {
    checkTimings[c.id] = results[i].ms;
  });

  // Deterministic order: blockers first, then warnings, then info.
  const rank = { blocker: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.checkId.localeCompare(b.checkId));

  // Issue #5: when the browser could not start, the letter grade stands
  // but the result is flagged partial — the report renders a visible
  // "browser checks unavailable" banner instead of presenting a grade
  // that silently excludes every live simulation.
  let partial: string | undefined;
  if (eligible.some((c) => c.id.startsWith("sim-"))) {
    const avail = await getBrowserAvailability(ctx).catch(() => null);
    if (avail && avail.state === "unavailable") partial = avail.reason;
  }

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
    ...(partial ? { partial } : {}),
    ...(ctx.forecast ? { forecast: ctx.forecast } : {}),
    findings,
    checkTimings,
    progress,
    screenshots: ctx.screenshots.sort(
      (a, b) => ["desktop", "tablet", "mobile"].indexOf(a.name) - ["desktop", "tablet", "mobile"].indexOf(b.name),
    ),
  };
}
