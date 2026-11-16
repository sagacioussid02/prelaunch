/**
 * The two scans the Actor sells, both reusing Prelaunch's own scan code
 * (lib/), so a finding reads exactly as it does in a Prelaunch report:
 *
 *   quick  lib/quickcheck.ts — exposed .env files, public source maps,
 *          security headers. A few read-only GETs, no browser, seconds.
 *   full   lib/scanner.ts runScan(…, "passive") — every check an anonymous
 *          Prelaunch scan runs, including the headless-browser simulations
 *          (load, mobile, accessibility, performance, links, journeys) and
 *          the launch-traffic forecast. Owner-only checks are listed as
 *          not run, as in the website report.
 *
 * Both refuse private, local and unresolvable hosts (lib/ssrf.ts) and
 * throw ScanInputError, which the core reports without charging, when the
 * URL is invalid or the site doesn't answer.
 */

import { randomUUID } from "node:crypto";
import { cachedGet, type ScanContext } from "../../lib/checks/types.ts";
import { prepareTarget, QuickCheckInputError, runQuickCheck } from "../../lib/quickcheck.ts";
import { OWNER_ONLY_REASON, runScan } from "../../lib/scanner.ts";
import { getShot } from "../../lib/store.ts";
import { ScanInputError, type ScanItem, type ScanType } from "./core.ts";

/** Stores one screenshot and returns a URL the caller can open. */
export type StoreShot = (key: string, jpeg: Buffer) => Promise<string>;

async function target(inputUrl: string): Promise<string> {
  try {
    return (await prepareTarget(inputUrl)).url;
  } catch (err) {
    if (err instanceof QuickCheckInputError) throw new ScanInputError(err.message);
    throw err;
  }
}

const UNREACHABLE = "the site did not respond; check the URL and that it is publicly reachable";

export async function quickScan(inputUrl: string): Promise<ScanItem> {
  const url = await target(inputUrl);
  let r;
  try {
    r = await runQuickCheck(url);
  } catch (err) {
    if (err instanceof QuickCheckInputError) throw new ScanInputError(err.message);
    throw err;
  }
  return {
    inputUrl,
    url: r.url,
    scanType: "quick",
    status: "done",
    grade: r.grade,
    score: r.score,
    ready: r.ready,
    blockers: r.summary.blockers,
    warnings: r.summary.warnings,
    info: r.summary.info,
    checks: r.checks,
    findings: r.findings,
    checkedAt: r.checkedAt,
    durationMs: r.durationMs,
  };
}

export async function fullScan(
  inputUrl: string,
  opts: { includeScreenshots: boolean; storeShot?: StoreShot },
): Promise<ScanItem> {
  const url = await target(inputUrl);

  // Same reachability probe as the quick check, so a typo'd or dead URL is
  // reported (and not charged) instead of graded as a wall of failures.
  const probe: ScanContext = { target: url, mode: "passive", cache: new Map(), scanId: "probe", screenshots: [] };
  const home = await cachedGet(probe, url + "/");
  if (home.status === 0) throw new ScanInputError(UNREACHABLE);

  const id = `apify-${randomUUID()}`;
  const r = await runScan(url, "passive", id);
  const progress = r.progress ?? [];
  const ran = progress.filter((p) => p.reason !== OWNER_ONLY_REASON);
  const allRan = ran.every((p) => p.outcome === "passed" || p.outcome === "issues");
  const count = (s: string) => r.findings.filter((f) => f.severity === s).length;

  let screenshots: ScanItem["screenshots"];
  if (opts.includeScreenshots && opts.storeShot && r.screenshots?.length) {
    screenshots = [];
    for (const s of r.screenshots) {
      const jpeg = await getShot(id, s.name);
      if (!jpeg) continue;
      const shotUrl = await opts.storeShot(`${id}-${s.name}.jpg`, jpeg).catch(() => null);
      if (shotUrl) screenshots.push({ name: s.name, label: s.label, url: shotUrl });
    }
  }

  return {
    inputUrl,
    url: r.url,
    scanType: "full",
    status: "done",
    grade: r.grade,
    score: r.score,
    ready: count("blocker") === 0 && allRan && !r.partial,
    blockers: count("blocker"),
    warnings: count("warning"),
    info: count("info"),
    checks: progress.map((p) => ({
      id: p.id,
      name: p.name,
      outcome: p.outcome ?? "not_run",
      findings: p.findingCount ?? 0,
      ...(p.reason ? { reason: p.reason } : {}),
    })),
    findings: r.findings,
    ...(r.partial ? { partial: r.partial } : {}),
    ...(r.forecast ? { forecast: r.forecast } : {}),
    ...(screenshots ? { screenshots } : {}),
    checkedAt: r.startedAt,
    durationMs: r.durationMs ?? 0,
  };
}

export function makeScanner(storeShot?: StoreShot) {
  return (scanType: ScanType, url: string, opts: { includeScreenshots: boolean }): Promise<ScanItem> =>
    scanType === "full" ? fullScan(url, { ...opts, storeShot }) : quickScan(url);
}
