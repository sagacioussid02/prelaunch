/**
 * Prelaunch for Chrome — scan engine.
 *
 * Runs Prelaunch's own passive checks (lib/checks) through Prelaunch's own
 * runner and grading (lib/scanner.ts runOne/grade), inside the extension's
 * service worker. build.mjs swaps three server-only modules for browser
 * stand-ins (see src/shims): the check registry, the headless-browser
 * layer and the SSRF guard. Nothing else in lib/ changes.
 *
 * Because the requests come from the user's own browser, the extension can
 * check sites the hosted scanner can't reach: localhost, Vercel preview
 * deployments behind Vercel Authentication, and staging sites behind a
 * login. Results never leave the browser.
 *
 * Tiers:
 * - quick (free): the three launch-blocking checks the Prelaunch API sells
 *   (lib/quickcheck.ts QUICK_CHECK_IDS). The popup gets the grade, score,
 *   counts and which checks found something, but not the findings.
 * - full (paid): every fetch-only passive check, with each finding, where
 *   it was found, the fix and a docs link, plus JSON and Markdown export.
 */

import type { ScanContext } from "../../lib/checks/types.ts";
import { cachedGet } from "../../lib/checks/types.ts";
import { metaFor } from "../../lib/checks/meta.ts";
import { QUICK_CHECK_IDS } from "../../lib/quickcheck.ts";
import { grade, runOne } from "../../lib/scanner.ts";
import { registry } from "./shims/registry.ts";
import { scanHost, setScanHost } from "./shims/ssrf.ts";
import { scanTarget, type ExtensionScanResult, type Tier } from "./shared.ts";

export type { ExtensionScanResult, Tier } from "./shared.ts";

export const FULL_CHECK_IDS: readonly string[] = registry.map((c) => c.id);

let fetchPatched = false;

/**
 * lib/checks/types.ts follows redirects by hand (redirect: "manual") so the
 * server can re-check every hop. Extension fetches get an opaque response
 * for "manual", so for the scanned host only, let the browser follow them
 * and send the user's cookies (that's what lets a Vercel-protected preview
 * or a logged-in staging site be checked). Every other fetch, ExtPay's
 * included, goes through untouched.
 */
function patchFetch(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const host = scanHost();
    let target: URL | null = null;
    try {
      target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    } catch {
      target = null;
    }
    if (!host || !target || target.hostname.toLowerCase() !== host) return nativeFetch(input, init);
    return nativeFetch(input, {
      ...init,
      redirect: init.redirect === "manual" ? "follow" : init.redirect,
      credentials: "include",
      cache: "no-store",
    });
  };
}

let running = false;

export async function scanSite(target: string, tier: Tier): Promise<ExtensionScanResult> {
  // Validate before taking the lock, so a bad target can't leave it held.
  const url = scanTarget(target);
  if (running) throw new Error("A scan is already running. Wait for it to finish.");
  running = true;
  patchFetch();
  setScanHost(new URL(url).hostname);
  const started = Date.now();
  try {
    const ctx: ScanContext = {
      target: url,
      mode: "passive",
      cache: new Map(),
      scanId: `ext-${started.toString(36)}`,
      screenshots: [],
    };

    const home = await cachedGet(ctx, url + "/");
    if (home.status === 0) {
      throw new Error("The site didn't respond to the extension. Reload the tab and try again.");
    }

    const ids: readonly string[] = tier === "full" ? FULL_CHECK_IDS : QUICK_CHECK_IDS;
    const checks = registry.filter((c) => ids.includes(c.id));
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
    const ready = summary.blockers === 0 && allRan && (tier === "quick" || score >= 70);

    return {
      tier,
      url,
      grade: letter,
      score,
      ready,
      summary,
      checks: checks.map((c, i) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        looksFor: metaFor(c.id).looksFor,
        outcome: runs[i].outcome,
        findings: runs[i].findings.length,
        ...(runs[i].findings.length
          ? { worst: [...runs[i].findings].sort((a, b) => rank[a.severity] - rank[b.severity])[0].severity }
          : {}),
        ...(runs[i].reason ? { reason: runs[i].reason } : {}),
      })),
      findings: tier === "full" ? findings : [],
      lockedChecks:
        tier === "full" ? [] : registry.filter((c) => !ids.includes(c.id)).map((c) => ({ id: c.id, name: c.name })),
      checkedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    };
  } finally {
    setScanHost(null);
    running = false;
  }
}
