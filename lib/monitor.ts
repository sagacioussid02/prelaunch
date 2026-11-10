/**
 * Deploy monitoring.
 *
 * A monitor watches one production URL. A deploy webhook (Vercel, GitHub
 * Actions, curl…) calls /api/monitor/{id}/deploy?token=…; that runs a passive
 * audit, diffs its blockers against the previous run and records an alert for
 * any NEW blocker. If an alert webhook (Slack/Discord/generic JSON) is
 * configured, it is notified too. Storage follows lib/store.ts (issue #3):
 * Postgres via lib/db.ts when DATABASE_URL is set, the JSON-file store
 * under DATA_ROOT otherwise. Only the internal load/save know which.
 *
 * Monitoring v2 (Phase 0 step 4, reconciled with the local prototype):
 * monitors gained an email channel with regression-only semantics and
 * per-incident dedupe (lib/notify.ts), a baseline pointer, domain
 * verification state (lib/ownership.ts; claim/verify endpoints), and a
 * cadence (intervalMinutes/nextRunAt) consumed by the scheduled runner
 * (lib/runner.ts, POST/GET /api/cron/run-monitors). All v2 fields are
 * optional on the stored record and backfilled on read, so monitors
 * created before the port keep working unchanged. The deploy token
 * stays as before: a SHA-256 hash at rest, compared timing-safely —
 * the per-monitor deploy secret for this codebase.
 *
 * Plan limits (Phase 0 step 5, lib/plans.ts): the owner's plan is
 * recorded at creation and, when a plan is passed in, the cadence is
 * floored at the plan minimum here. Enforcement (per-owner count,
 * duplicate guard, full-mode gate) lives in the creation route, not
 * in this module — internal callers (runner, tests) keep the plain
 * 60–10080 clamp they have always had.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DATA_ROOT, getScan, newScanId } from "./store.ts";
import { dbConfigured, dbQuery } from "./db.ts";
import { startScanJob } from "./jobs.ts";
import { normalizeUrl } from "./scanner.ts";
import { assertSafeHostname } from "./ssrf.ts";
import { fetchWithTimeout } from "./checks/types.ts";
import type { Finding } from "./checks/types.ts";
import { normalizeEmail } from "./waitlist.ts";
import {
  VERIFICATION_PATH,
  VERIFICATION_TIMEOUT_MS,
  generateSecret,
  verificationBodyMatches,
} from "./ownership.ts";
import {
  computeRegression,
  decideEmailNotification,
  notifyRegression,
  regressionHashFor,
  type RunRegression,
} from "./notify.ts";
import {
  clampIntervalForPlan,
  type Plan,
  type PlanId,
} from "./plans.ts";

export const MONITOR_COOLDOWN_MS = 60_000;
const MAX_RUNS = 50;

export interface MonitorRun {
  scanId: string;
  at: string;
  trigger: "baseline" | "deploy" | "manual" | "scheduled";
  score: number;
  grade: string;
  blockers: number;
  warnings: number;
  /** Blockers not present in the previous run */
  newBlockers: Array<Pick<Finding, "checkId" | "title" | "location" | "fix">>;
  alertSent: boolean;
  /** True when the regression email was recorded as sent/queued (v2). */
  emailSent?: boolean;
}

interface StoredMonitor {
  id: string;
  url: string;
  secretHash: string;
  alertWebhook?: string;
  createdAt: string;
  lastRunAt?: string;
  running: boolean;
  runs: MonitorRun[];
  /* ---- v2 fields (step 4): optional so pre-port rows stay valid ---- */
  /** Regression-email address; null when unset. */
  email?: string | null;
  /** Default true: email only on regressions. False = email every non-baseline run. */
  regressionOnly?: boolean;
  /** False stops the scheduled runner (deploy/manual runs still work). */
  enabled?: boolean;
  /** Domain ownership proven via lib/ownership.ts claim/verify. */
  domainVerified?: boolean;
  /** Current claim token; never exposed by the public view. */
  verificationToken?: string | null;
  /** First completed run — the baseline every later run diffs against. */
  baselineScanId?: string | null;
  baselineScore?: number | null;
  /** Scheduled cadence in minutes (60–10080); the runner's clock. */
  intervalMinutes?: number;
  /** Next scheduled run; null until the first completed run schedules one. */
  nextRunAt?: string | null;
  /** Dedupe state for regression email (lib/notify.ts). */
  lastNotifiedHash?: string | null;
  lastNotifiedAt?: string | null;
  /* ---- plan field (step 5): optional so pre-port rows stay valid ---- */
  /** Owner's plan at creation time (lib/plans.ts); backfilled to "free". */
  plan?: PlanId;
}

/** What the public dashboard may see (no secret hash, no webhook URL, no claim token, no raw email). */
export interface PublicMonitor {
  id: string;
  url: string;
  createdAt: string;
  running: boolean;
  hasAlertWebhook: boolean;
  hasNotifyEmail: boolean;
  domainVerified: boolean;
  enabled: boolean;
  plan: PlanId;
  baselineScanId: string | null;
  nextRunAt: string | null;
  lastNotifiedAt: string | null;
  runs: MonitorRun[];
}

/** Clamp a requested cadence to the supported window; junk input gets the daily default. */
export function clampIntervalMinutes(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1440;
  return Math.min(10080, Math.max(60, Math.round(n)));
}

/**
 * Backfill v2 fields for monitors created before the port. Legacy rows
 * default to unverified (the scheduled runner will not touch them until
 * the owner verifies the domain), email-less, regression-only, enabled,
 * with the baseline read off the first recorded run when there is one.
 */
export function normalizeStoredMonitor(m: StoredMonitor): StoredMonitor {
  const first = m.runs?.[0];
  return {
    ...m,
    email: m.email ?? null,
    regressionOnly: m.regressionOnly ?? true,
    enabled: m.enabled ?? true,
    domainVerified: m.domainVerified ?? false,
    verificationToken: m.verificationToken ?? null,
    baselineScanId: m.baselineScanId ?? (first ? first.scanId : null),
    baselineScore: m.baselineScore ?? (first ? first.score : null),
    intervalMinutes: clampIntervalMinutes(m.intervalMinutes ?? 1440),
    nextRunAt: m.nextRunAt ?? null,
    lastNotifiedHash: m.lastNotifiedHash ?? null,
    lastNotifiedAt: m.lastNotifiedAt ?? null,
    plan: m.plan === "pro" ? "pro" : "free",
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function fileFor(id: string): Promise<string> {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("bad monitor id");
  const dir = join(DATA_ROOT, "monitors");
  await fs.mkdir(dir, { recursive: true });
  return join(dir, `${id}.json`);
}

async function load(id: string): Promise<StoredMonitor | null> {
  if (dbConfigured()) {
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    const rows = await dbQuery<{ data: StoredMonitor }>(
      `SELECT data FROM monitors WHERE id = $1`,
      [id],
    );
    return rows[0] ? normalizeStoredMonitor(rows[0].data) : null;
  }
  try {
    const raw = JSON.parse(await fs.readFile(await fileFor(id), "utf8")) as StoredMonitor;
    return normalizeStoredMonitor(raw);
  } catch {
    return null;
  }
}

/** Internal record (includes secrets) for the runner and claim/verify routes. */
export async function getStoredMonitor(id: string): Promise<StoredMonitor | null> {
  return load(id);
}

/** Persist an internal record obtained via getStoredMonitor/listStoredMonitors. */
export async function updateStoredMonitor(m: StoredMonitor): Promise<void> {
  await save(m);
}

/** Every monitor, normalized — the scheduled runner's working set. */
export async function listStoredMonitors(): Promise<StoredMonitor[]> {
  if (dbConfigured()) {
    const rows = await dbQuery<{ data: StoredMonitor }>(
      `SELECT data FROM monitors ORDER BY created_at`,
    );
    return rows.map((r) => normalizeStoredMonitor(r.data));
  }
  const dir = join(DATA_ROOT, "monitors");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: StoredMonitor[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await fs.readFile(join(dir, entry), "utf8")) as StoredMonitor;
      out.push(normalizeStoredMonitor(raw));
    } catch {
      // Corrupt or half-written file — skip it, never fail the whole run.
    }
  }
  return out;
}

async function save(m: StoredMonitor): Promise<void> {
  if (dbConfigured()) {
    await dbQuery(
      `INSERT INTO monitors (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [m.id, JSON.stringify(m)],
    );
    return;
  }
  const file = await fileFor(m.id);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(m));
  await fs.rename(tmp, file);
}

function toPublic(m: StoredMonitor): PublicMonitor {
  const n = normalizeStoredMonitor(m);
  return {
    id: n.id,
    url: n.url,
    createdAt: n.createdAt,
    running: n.running,
    hasAlertWebhook: !!n.alertWebhook,
    hasNotifyEmail: !!n.email,
    domainVerified: !!n.domainVerified,
    enabled: n.enabled !== false,
    plan: n.plan === "pro" ? "pro" : "free",
    baselineScanId: n.baselineScanId ?? null,
    nextRunAt: n.nextRunAt ?? null,
    lastNotifiedAt: n.lastNotifiedAt ?? null,
    runs: n.runs,
  };
}

export async function getMonitor(id: string): Promise<PublicMonitor | null> {
  const m = await load(id);
  return m ? toPublic(m) : null;
}

export async function verifyToken(id: string, token: string | null): Promise<boolean> {
  const m = await load(id);
  if (!m || !token) return false;
  const a = Buffer.from(sha(token));
  const b = Buffer.from(m.secretHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function assertWebhook(raw: string): Promise<string> {
  const u = new URL(raw);
  if (u.protocol !== "https:") throw new Error("alert webhook must be https");
  await assertSafeHostname(u.hostname);
  return u.toString();
}

export async function createMonitor(
  rawUrl: string,
  alertWebhook?: string,
  opts: {
    email?: string | null;
    intervalMinutes?: unknown;
    regressionOnly?: boolean;
    /** Owner's plan (step 5): recorded on the monitor; the cadence is floored at the plan minimum. */
    plan?: Plan;
  } = {},
): Promise<{ id: string; token: string; url: string }> {
  const url = normalizeUrl(rawUrl);
  await assertSafeHostname(new URL(url).hostname);
  const hook = alertWebhook?.trim() ? await assertWebhook(alertWebhook.trim()) : undefined;
  let email: string | null = null;
  if (opts.email != null && String(opts.email).trim() !== "") {
    email = normalizeEmail(opts.email);
    if (!email) throw new Error("invalid email");
  }
  const id = randomUUID();
  const token = randomBytes(24).toString("hex");
  await save({
    id,
    url,
    secretHash: sha(token),
    alertWebhook: hook,
    createdAt: new Date().toISOString(),
    running: false,
    runs: [],
    email,
    regressionOnly: opts.regressionOnly ?? true,
    enabled: true,
    domainVerified: false,
    verificationToken: null,
    baselineScanId: null,
    baselineScore: null,
    // With a plan (the creation route), the cadence is floored at the
    // plan minimum — a Free monitor asking for hourly checks gets
    // daily. Without one (internal callers), the plain clamp applies.
    intervalMinutes: opts.plan
      ? clampIntervalForPlan(opts.plan, opts.intervalMinutes)
      : clampIntervalMinutes(opts.intervalMinutes ?? 1440),
    nextRunAt: null,
    lastNotifiedHash: null,
    lastNotifiedAt: null,
    plan: opts.plan?.id ?? "free",
  });
  return { id, token, url };
}

/* ---------------- plan-limit counting (step 5) ---------------- */

/**
 * The owner's monitors that count against their plan (lib/plans.ts).
 * "Active" here is the repo analogue of the prototype's `active`
 * flag: a monitor with enabled === false does not count — it consumes
 * no plan slot and does not trigger the duplicate guard — mirroring
 * the prototype, where inactive monitors are excluded from both.
 * Email comparison uses the normalized form stored at creation.
 */
export async function listActiveMonitorsByEmail(email: string): Promise<StoredMonitor[]> {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  const all = await listStoredMonitors();
  return all.filter((m) => m.enabled !== false && m.email === normalized);
}

/** The owner's active monitor for an exact (already normalized) URL, if any — the duplicate guard. */
export async function findActiveMonitorByEmailUrl(
  email: string,
  normalizedUrl: string,
): Promise<StoredMonitor | null> {
  const mine = await listActiveMonitorsByEmail(email);
  return mine.find((m) => m.url === normalizedUrl) ?? null;
}

const key = (f: Pick<Finding, "checkId" | "title">) => `${f.checkId}|${f.title}`;

async function sendAlert(m: StoredMonitor, run: MonitorRun, reportUrl: string): Promise<boolean> {
  if (!m.alertWebhook) return false;
  const lines = run.newBlockers.map((b) => `• ${b.title}`).join("\n");
  const text = `PreLaunch Check: ${run.newBlockers.length} new blocker(s) on ${m.url} (grade ${run.grade})\n${lines}\n${reportUrl}`;
  try {
    const res = await fetchWithTimeout(m.alertWebhook, 8000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `text` for Slack, `content` for Discord.
      body: JSON.stringify({ text, content: text, url: m.url, scanId: run.scanId, newBlockers: run.newBlockers }),
    });
    await res.arrayBuffer().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

export type RunStart = { ok: true; scanId: string } | { ok: false; reason: "cooldown" | "busy" | "missing" | "error"; retryInMs?: number };

/** Starts an audit in the background; the result is diffed and recorded when it finishes. */
export async function runMonitor(id: string, trigger: "deploy" | "manual" | "scheduled", baseUrl: string): Promise<RunStart> {
  const m = await load(id);
  if (!m) return { ok: false, reason: "missing" };
  const since = m.lastRunAt ? Date.now() - new Date(m.lastRunAt).getTime() : Infinity;
  if (since < MONITOR_COOLDOWN_MS && !(m.running && since > 5 * 60_000)) {
    return { ok: false, reason: "cooldown", retryInMs: MONITOR_COOLDOWN_MS - since };
  }
  if (m.running && since < 5 * 60_000) return { ok: false, reason: "busy" };

  const scanId = newScanId();
  m.running = true;
  m.lastRunAt = new Date().toISOString();
  await save(m);

  let job: Awaited<ReturnType<typeof startScanJob>>;
  try {
    job = await startScanJob(m.url, "passive", scanId);
  } catch (err) {
    // The job could not even start: never leave the monitor wedged in
    // `running` — clear the flag so the next trigger is not told "busy"
    // until the 5-minute stale window expires.
    const fresh = (await load(id)) ?? m;
    fresh.running = false;
    await save(fresh).catch(() => {});
    console.error("monitor scan failed to start", id, err);
    return { ok: false, reason: "error" };
  }
  void job.done.then(async (result) => {
    const fresh = (await load(id)) ?? m;
    fresh.running = false;
    if (result) {
      const prev = fresh.runs[fresh.runs.length - 1];
      const prevScan = prev ? await getScan(prev.scanId) : null;
      const known = new Set((prevScan?.findings ?? []).filter((f) => f.severity === "blocker").map(key));
      const blockers = result.findings.filter((f) => f.severity === "blocker");
      const newBlockers = prev
        ? blockers.filter((f) => !known.has(key(f))).map(({ checkId, title, location, fix }) => ({ checkId, title, location, fix }))
        : [];
      const run: MonitorRun = {
        scanId,
        at: new Date().toISOString(),
        trigger: prev ? trigger : "baseline",
        score: result.score,
        grade: result.grade,
        blockers: blockers.length,
        warnings: result.findings.filter((f) => f.severity === "warning").length,
        newBlockers,
        alertSent: false,
      };
      if (newBlockers.length) run.alertSent = await sendAlert(fresh, run, `${baseUrl}/r/${scanId}`);

      /* ---- v2: baseline, regression email, schedule advance ---- */
      if (!fresh.baselineScanId) {
        fresh.baselineScanId = scanId;
        fresh.baselineScore = result.score;
      }
      const prevFindings = prevScan?.findings ?? [];
      const prevKeys = new Set(prevFindings.map(key));
      const nowKeys = new Set(result.findings.map(key));
      const info: RunRegression = {
        newBlockers,
        prevScore: prev ? prev.score : null,
        nextScore: result.score,
        prevGrade: prev ? prev.grade : null,
        nextGrade: result.grade,
        newFindingsCount: result.findings.filter((f) => !prevKeys.has(key(f))).length,
        resolvedCount: prevFindings.filter((f) => !nowKeys.has(key(f))).length,
      };

      const regression = computeRegression({
        prevScore: info.prevScore,
        nextScore: info.nextScore,
        newBlockers,
      });
      const hash = regressionHashFor({
        newBlockers,
        prevScore: info.prevScore,
        nextScore: info.nextScore,
      });
      const decision = decideEmailNotification({
        email: fresh.email ?? null,
        regressionOnly: fresh.regressionOnly !== false,
        isBaseline: !prev,
        regression,
        hash,
        lastNotifiedHash: fresh.lastNotifiedHash ?? null,
      });
      if (decision.action === "skip" && decision.clearHash) fresh.lastNotifiedHash = null;
      if (decision.action === "send") {
        try {
          const record = await notifyRegression({
            monitorId: id,
            monitorUrl: fresh.url,
            email: fresh.email ?? null,
            regressionOnly: fresh.regressionOnly !== false,
            regression,
            info,
            scanId,
            reportUrl: `${baseUrl}/r/${scanId}`,
          });
          if (record) {
            run.emailSent = record.status !== "failed";
            fresh.lastNotifiedHash = hash;
            fresh.lastNotifiedAt = record.createdAt;
          }
        } catch (err) {
          // A notification-store failure must not lose the run itself.
          console.error("monitor notification failed", id, err);
        }
      }
      fresh.nextRunAt = new Date(
        Date.parse(run.at) + clampIntervalMinutes(fresh.intervalMinutes ?? 1440) * 60_000,
      ).toISOString();

      fresh.runs = [...fresh.runs, run].slice(-MAX_RUNS);
    }
    await save(fresh);
  });
  return { ok: true, scanId };
}

/* ---------------- domain verification (step 4, PR-B) ---------------- */

/**
 * Issue (or re-issue) a domain-verification claim token for a monitor.
 * Re-issuing invalidates the previous token — the newest token is the
 * only one verify accepts — so a leaked token is revoked by re-claiming.
 * Throws "monitor not found" for an unknown id (routes map it to 404).
 */
export async function requestVerificationClaim(
  id: string,
): Promise<{ token: string; path: string; url: string }> {
  const m = await load(id);
  if (!m) throw new Error("monitor not found");
  m.verificationToken = generateSecret(16);
  await save(m);
  return {
    token: m.verificationToken,
    path: VERIFICATION_PATH,
    url: `${m.url}${VERIFICATION_PATH}`,
  };
}

/**
 * Verify domain ownership: fetch the well-known file from the monitored
 * site (SSRF-guarded, the same fetcher the scanner uses) and compare
 * its body to the current claim token. On match the monitor is marked
 * verified, which is what entitles it to scheduled runs. On any fetch
 * failure or mismatch it stays unverified and the caller gets a reason,
 * not a crash — a site that blocks bots must not 500.
 */
export async function verifyDomainOwnership(
  id: string,
): Promise<{ verified: boolean; reason: string }> {
  const m = await load(id);
  if (!m) throw new Error("monitor not found");
  if (!m.verificationToken) {
    return { verified: false, reason: "no verification token — claim one first" };
  }
  let body = "";
  let status = 0;
  try {
    const res = await fetchWithTimeout(`${m.url}${VERIFICATION_PATH}`, VERIFICATION_TIMEOUT_MS, {
      headers: { "User-Agent": "PreLaunchCheck/0.1 (ownership verification)" },
    });
    status = res.status;
    body = await res.text().catch(() => "");
  } catch (err) {
    return {
      verified: false,
      reason: `verification fetch failed: ${String((err as Error).message ?? err)}`,
    };
  }
  if (status !== 200) {
    return { verified: false, reason: `verification file returned ${status}` };
  }
  if (!verificationBodyMatches(body, m.verificationToken)) {
    return { verified: false, reason: "verification file content does not match the claim token" };
  }
  m.domainVerified = true;
  await save(m);
  return { verified: true, reason: "verified" };
}
