/**
 * Apify Actor core: input parsing, the scan loop and pay-per-event charging.
 *
 * Kept free of the Apify SDK and of the scanner so it can be unit-tested
 * with fakes (scripts/test-apify-actor.ts). main.ts wires the real SDK in.
 *
 * Billing rules (see docs/apify-listing.md):
 *   - one charge per finished scan: event "quick-scan" or "full-scan"
 *   - nothing is charged for a URL that is invalid, refused by the SSRF
 *     guard, or doesn't answer; it gets an error item instead
 *   - a scan only starts while the run's spending limit still covers it
 *     (counting scans already in flight), so a run never overspends
 */

export type ScanType = "quick" | "full";

export const SCAN_EVENTS: Record<ScanType, string> = {
  quick: "quick-scan",
  full: "full-scan",
};

/** Hard cap on URLs per run, so one run can't hammer the scanner. */
export const MAX_URLS_PER_RUN = 100;
/** Quick scans are a few GETs each; full scans drive a headless browser. */
export const DEFAULT_CONCURRENCY: Record<ScanType, number> = { quick: 5, full: 1 };
export const MAX_CONCURRENCY: Record<ScanType, number> = { quick: 10, full: 2 };

export interface ActorOptions {
  /** Raw URL strings as given, de-duplicated, in input order. */
  urls: string[];
  scanType: ScanType;
  includeScreenshots: boolean;
  concurrency: number;
  /** URLs dropped before scanning (over the cap). */
  skipped: string[];
}

export class ActorInputError extends Error {}

/** Thrown by a scanner when the URL can't be scanned; never charged. */
export class ScanInputError extends Error {}

function asUrlList(v: unknown): string[] {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of list) {
    // stringList editor gives strings; requestListSources-style callers
    // (and some agents) send { url }. Accept both.
    const s = typeof item === "string" ? item : (item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string")
      ? (item as { url: string }).url
      : null;
    if (s === null) throw new ActorInputError("each entry in urls must be a URL string");
    if (s.trim()) out.push(s.trim());
  }
  return out;
}

export function parseInput(raw: unknown): ActorOptions {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const all = [...asUrlList(input.urls), ...asUrlList(input.url)];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const u of all) {
    const key = (/^https?:\/\//i.test(u) ? u : `https://${u}`).toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(u);
  }
  if (unique.length === 0) throw new ActorInputError("give at least one URL in urls");

  const scanType = input.scanType ?? "quick";
  if (scanType !== "quick" && scanType !== "full") {
    throw new ActorInputError('scanType must be "quick" or "full"');
  }

  let concurrency = DEFAULT_CONCURRENCY[scanType];
  if (input.maxConcurrency != null) {
    const n = Number(input.maxConcurrency);
    if (!Number.isInteger(n) || n < 1) throw new ActorInputError("maxConcurrency must be a whole number of 1 or more");
    concurrency = Math.min(n, MAX_CONCURRENCY[scanType]);
  }

  return {
    urls: unique.slice(0, MAX_URLS_PER_RUN),
    skipped: unique.slice(MAX_URLS_PER_RUN),
    scanType,
    includeScreenshots: input.includeScreenshots !== false,
    concurrency,
  };
}

export interface CheckSummary {
  id: string;
  name: string;
  outcome: "passed" | "issues" | "failed" | "not_run";
  findings: number;
  reason?: string;
}

export interface ScanItem {
  inputUrl: string;
  url: string;
  scanType: ScanType;
  status: "done";
  grade: string;
  score: number;
  ready: boolean;
  blockers: number;
  warnings: number;
  info: number;
  checks: CheckSummary[];
  findings: Array<{ checkId: string; severity: string; title: string; location: string; fix: string; fixLink?: string }>;
  partial?: string;
  forecast?: unknown;
  screenshots?: Array<{ name: string; label: string; url: string }>;
  checkedAt: string;
  durationMs: number;
}

export interface ErrorItem {
  inputUrl: string;
  scanType: ScanType;
  status: "error";
  error: string;
}

export interface ChargeOutcome {
  eventChargeLimitReached: boolean;
  chargedCount: number;
}

export interface ActorDeps {
  scan(scanType: ScanType, url: string, opts: { includeScreenshots: boolean }): Promise<ScanItem>;
  pushData(item: ScanItem | ErrorItem): Promise<void>;
  charge(eventName: string): Promise<ChargeOutcome>;
  /** How many more events of this type the run's spending limit allows (Infinity locally). */
  remaining(eventName: string): number;
  log: { info(msg: string): void; warning(msg: string): void };
}

export interface RunSummary {
  scanType: ScanType;
  requested: number;
  scanned: number;
  charged: number;
  errors: number;
  /** URLs not scanned because the run's spending limit was reached. */
  notScannedBudget: string[];
  /** URLs not scanned because they were over the per-run cap. */
  notScannedOverCap: string[];
  ready: number;
  notReady: number;
}

export async function runActor(opts: ActorOptions, deps: ActorDeps): Promise<RunSummary> {
  const event = SCAN_EVENTS[opts.scanType];
  const summary: RunSummary = {
    scanType: opts.scanType,
    requested: opts.urls.length + opts.skipped.length,
    scanned: 0,
    charged: 0,
    errors: 0,
    notScannedBudget: [],
    notScannedOverCap: [...opts.skipped],
    ready: 0,
    notReady: 0,
  };
  if (opts.skipped.length) {
    deps.log.warning(`Only the first ${MAX_URLS_PER_RUN} URLs are scanned in one run; ${opts.skipped.length} were skipped.`);
  }

  const queue = opts.urls.map((url, i) => ({ url, i }));
  let inFlight = 0;
  let budgetHit = false;

  const worker = async (): Promise<void> => {
    while (queue.length) {
      // Start a scan only if the spending limit covers it plus every scan
      // already running (those will be charged when they finish).
      if (budgetHit || deps.remaining(event) - inFlight < 1) {
        budgetHit = true;
        summary.notScannedBudget.push(...queue.splice(0).map((q) => q.url));
        return;
      }
      const { url } = queue.shift()!;
      inFlight++;
      try {
        const item = await deps.scan(opts.scanType, url, { includeScreenshots: opts.includeScreenshots });
        await deps.pushData(item);
        summary.scanned++;
        if (item.ready) summary.ready++;
        else summary.notReady++;
        const res = await deps.charge(event);
        summary.charged += res.chargedCount;
        if (res.eventChargeLimitReached) budgetHit = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.errors++;
        if (!(err instanceof ScanInputError)) deps.log.warning(`Scan of ${url} failed: ${message}`);
        await deps.pushData({ inputUrl: url, scanType: opts.scanType, status: "error", error: message });
      } finally {
        inFlight--;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, queue.length) }, worker));

  if (summary.notScannedBudget.length) {
    deps.log.warning(
      `Spending limit reached: ${summary.notScannedBudget.length} URL(s) were not scanned and not charged. Raise the run's maximum cost to scan them.`,
    );
  }
  return summary;
}

export function statusMessage(s: RunSummary): string {
  const parts = [`Scanned ${s.scanned} of ${s.requested} site(s): ${s.ready} launch-ready, ${s.notReady} not ready`];
  if (s.errors) parts.push(`${s.errors} could not be scanned (not charged)`);
  if (s.notScannedBudget.length) parts.push(`${s.notScannedBudget.length} skipped at the spending limit`);
  if (s.notScannedOverCap.length) parts.push(`${s.notScannedOverCap.length} over the ${MAX_URLS_PER_RUN}-URL cap`);
  return parts.join("; ") + ".";
}
