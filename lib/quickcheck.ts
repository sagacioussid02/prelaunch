/**
 * Quick launch check: the three passive Prelaunch checks sold as a
 * pay-per-call API (POST /api/v1/check, listed on RapidAPI).
 *
 * Why these three: each catches something a team would block a release
 * on, each is a handful of read-only GETs (seconds, no headless browser),
 * and each gives a clear yes/no a CI job or an agent can act on.
 *   - exposed-env       /.env, /.env.local, /.env.production publicly readable
 *   - sourcemap-leak    public .map files that ship the original source
 *   - security-headers  CSP, HSTS, X-Frame-Options, nosniff, Referrer- and
 *                       Permissions-Policy, plus plain-HTTP serving
 *
 * They run through the same runner (runOne), per-check timeout, SSRF guard
 * and grading as a full scan, so a finding here reads exactly as it would
 * in a Prelaunch report. Results are returned inline and not stored.
 */

import { registry } from "./checks/index.ts";
import type { Check, CheckOutcome, Finding, ScanContext } from "./checks/types.ts";
import { cachedGet } from "./checks/types.ts";
import { grade, normalizeUrl, runOne } from "./scanner.ts";
import { assertSafeHostname } from "./ssrf.ts";

export const QUICK_CHECK_IDS = ["exposed-env", "sourcemap-leak", "security-headers"] as const;

export function quickChecks(): Check[] {
  return QUICK_CHECK_IDS.map((id) => {
    const c = registry.find((r) => r.id === id);
    if (!c) throw new Error(`quickcheck: check ${id} is missing from the registry`);
    if (!c.modes.includes("passive")) throw new Error(`quickcheck: ${id} is not passive`);
    return c;
  });
}

export interface QuickCheckResult {
  url: string;
  /** A+ to F, same bands as a Prelaunch report */
  grade: string;
  /** 0 to 100: start at 100, blocker -15, warning -5, info -1 */
  score: number;
  /** No blockers and every check ran */
  ready: boolean;
  summary: { blockers: number; warnings: number; info: number };
  checks: Array<{ id: string; name: string; outcome: CheckOutcome; findings: number; reason?: string }>;
  findings: Finding[];
  checkedAt: string;
  durationMs: number;
}

export class QuickCheckInputError extends Error {
  readonly status: 400 | 422;
  constructor(status: 400 | 422, message: string) {
    super(message);
    this.status = status;
  }
}

/** Parses and SSRF-checks the target. Throws QuickCheckInputError (400). */
export async function prepareTarget(raw: unknown): Promise<{ url: string; host: string }> {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new QuickCheckInputError(400, "missing url");
  }
  if (raw.length > 2048) throw new QuickCheckInputError(400, "url is too long");
  let url: string;
  let host: string;
  try {
    url = normalizeUrl(raw);
    host = new URL(url).hostname;
  } catch {
    throw new QuickCheckInputError(400, "invalid url");
  }
  try {
    await assertSafeHostname(host);
  } catch {
    throw new QuickCheckInputError(400, "url must be a public website (private, local and unresolvable hosts are refused)");
  }
  return { url, host };
}

/**
 * Runs the three checks against a prepared target. Throws
 * QuickCheckInputError (422) when the site doesn't answer at all, so a
 * typo'd URL is reported as such instead of graded.
 */
export async function runQuickCheck(url: string): Promise<QuickCheckResult> {
  const started = Date.now();
  const ctx: ScanContext = {
    target: url,
    mode: "passive",
    cache: new Map(),
    scanId: `api-${started.toString(36)}`,
    screenshots: [],
  };

  // Prime the cache with the homepage: every check reads it, and an
  // unreachable site is answered with a clear 422 instead of a grade.
  const home = await cachedGet(ctx, url + "/");
  if (home.status === 0) {
    throw new QuickCheckInputError(422, "the site did not respond; check the URL and that it is publicly reachable");
  }

  const checks = quickChecks();
  const runs = await Promise.all(checks.map((c) => runOne(c, ctx)));

  const rank = { blocker: 0, warning: 1, info: 2 } as const;
  const findings = runs
    .flatMap((r) => r.findings)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || a.checkId.localeCompare(b.checkId));
  const { score, grade: letter } = grade(findings);
  const summary = {
    blockers: findings.filter((f) => f.severity === "blocker").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
  const allRan = runs.every((r) => r.outcome === "passed" || r.outcome === "issues");

  return {
    url,
    grade: letter,
    score,
    ready: summary.blockers === 0 && allRan,
    summary,
    checks: checks.map((c, i) => ({
      id: c.id,
      name: c.name,
      outcome: runs[i].outcome,
      findings: runs[i].findings.length,
      ...(runs[i].reason ? { reason: runs[i].reason } : {}),
    })),
    findings,
    checkedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
  };
}
