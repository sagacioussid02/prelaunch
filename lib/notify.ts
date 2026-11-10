/**
 * Regression email notifications (Phase 0 step 4, ported and adapted
 * from the local prototype's lib/notify.ts).
 *
 * The repo already alerts a Slack/Discord/generic webhook on new
 * blockers (lib/monitor.ts sendAlert). This module adds the email
 * channel and the shared regression semantics both channels describe:
 *
 * - A run is a REGRESSION when it introduces a new blocker (vs the
 *   previous completed run) or the score drops by 10+ points.
 * - By default a monitor is regression-only: email goes out for
 *   regressions and nothing else — clean checks, small drifts and
 *   improvements stay silent. (A monitor can opt out with
 *   regressionOnly: false and get an email per non-baseline run.)
 * - Dedupe: each regression is hashed from its blocker set (or the
 *   score pair when the regression is a pure score drop). The same
 *   hash never emails twice; a non-regression run clears the stored
 *   hash, so if the site regresses again the same way after recovering,
 *   that DOES email — "notify once per distinct regression set" per
 *   incident, not once forever.
 *
 * Delivery: Resend when RESEND_API_KEY + NOTIFY_FROM are set (one fetch
 * call, no SDK). A provider failure is recorded, never thrown — a
 * failed email must not fail the monitor run. Without a provider the
 * notification is recorded as "queued", so local/dev runs exercise the
 * full run → diff → notify path with no email account, and flipping on
 * Resend later does not lose the history of what would have been sent.
 *
 * Persistence follows the storage switch from step 1: a `notifications`
 * table via lib/db.ts when DATABASE_URL is set, a JSON file under
 * DATA_ROOT otherwise. Records never carry secrets — only the monitor
 * id, scan id, rendered subject/body, and the outcome.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_ROOT } from "./store.ts";
import { dbConfigured, dbQuery } from "./db.ts";
import type { Finding } from "./checks/types.ts";

export interface Notification {
  id: string;
  monitorId: string;
  scanId: string;
  email: string;
  subject: string;
  body: string;
  /** sent | queued (no provider configured) | failed (provider error) */
  status: "sent" | "queued" | "failed";
  error?: string;
  createdAt: string;
}

/** The slice of a completed run the notification logic reasons about. */
export interface RunRegression {
  newBlockers: Array<Pick<Finding, "checkId" | "title" | "location" | "fix">>;
  prevScore: number | null;
  nextScore: number;
  prevGrade: string | null;
  nextGrade: string;
  /** Findings present now that were absent in the previous run. */
  newFindingsCount: number;
  /** Findings present in the previous run that are gone now. */
  resolvedCount: number;
}

const FILE = "notifications.json";

/** Score drop (points) against the previous run that counts as a regression. */
export const SCORE_DROP_THRESHOLD = 10;

const blockerKey = (f: Pick<Finding, "checkId" | "title" | "location">) =>
  `${f.checkId}\0${f.title}\0${f.location}`;

/** Pure: is this run a regression vs its predecessor? */
export function computeRegression(input: {
  prevScore: number | null;
  nextScore: number;
  newBlockers: unknown[];
}): boolean {
  if (input.newBlockers.length > 0) return true;
  if (input.prevScore === null) return false;
  return input.prevScore - input.nextScore >= SCORE_DROP_THRESHOLD;
}

/**
 * Pure: stable identity of a regression — the sorted blocker set, or
 * the score pair for a pure score-drop regression. Order-insensitive,
 * so the same incident hashes identically across runs.
 */
export function regressionHashFor(input: {
  newBlockers: Array<Pick<Finding, "checkId" | "title" | "location">>;
  prevScore: number | null;
  nextScore: number;
}): string {
  const basis =
    input.newBlockers.length > 0
      ? input.newBlockers.map(blockerKey).sort().join("\n")
      : `score:${input.prevScore}->${input.nextScore}`;
  return createHash("sha256").update(basis).digest("hex");
}

export type EmailDecision =
  | { action: "send" }
  | {
      action: "skip";
      reason: "no-email" | "baseline" | "not-regression" | "duplicate";
      /** True when the stored dedupe hash should be cleared (site recovered). */
      clearHash: boolean;
    };

/**
 * Pure: decide whether a completed run emails the monitor's address.
 * The dedupe/clearing semantics are described in the module header.
 */
export function decideEmailNotification(input: {
  email: string | null;
  regressionOnly: boolean;
  isBaseline: boolean;
  regression: boolean;
  hash: string;
  lastNotifiedHash: string | null;
}): EmailDecision {
  if (!input.email) return { action: "skip", reason: "no-email", clearHash: false };
  if (input.isBaseline) return { action: "skip", reason: "baseline", clearHash: false };
  if (input.regressionOnly && !input.regression) {
    // A healthy run ends the current incident: the same regression
    // reappearing later must notify again.
    return { action: "skip", reason: "not-regression", clearHash: true };
  }
  if (input.hash === input.lastNotifiedHash) {
    return { action: "skip", reason: "duplicate", clearHash: false };
  }
  return { action: "send" };
}

export function renderMonitorEmail(input: {
  monitorUrl: string;
  info: RunRegression;
  reportUrl: string;
}): { subject: string; body: string } {
  const { monitorUrl, info, reportUrl } = input;
  const scoreLine =
    info.prevScore === null
      ? `Score: ${info.nextScore} (${info.nextGrade}).`
      : `Score: ${info.prevScore} (${info.prevGrade}) → ${info.nextScore} (${info.nextGrade}), delta ${info.nextScore - info.prevScore}.`;
  const blockerLine =
    info.newBlockers.length > 0
      ? `New blockers (${info.newBlockers.length}):\n${info.newBlockers
          .map((f) => `- ${f.title} (${f.location}) — ${f.fix}`)
          .join("\n")}`
      : "No new blockers — the regression is a score drop.";
  const subject =
    info.prevScore === null
      ? `PreLaunch Check: ${monitorUrl} scored ${info.nextScore} (${info.nextGrade})`
      : `PreLaunch Check regression on ${monitorUrl}: ${info.prevScore} → ${info.nextScore} (${info.prevGrade} → ${info.nextGrade})`;
  const body = [
    `PreLaunch Check found a regression on ${monitorUrl}.`,
    ``,
    scoreLine,
    `New findings: ${info.newFindingsCount}. Resolved findings: ${info.resolvedCount}.`,
    ``,
    blockerLine,
    ``,
    `Full report: ${reportUrl}`,
    ``,
    `You are receiving this because this URL is monitored by PreLaunch Check.`,
  ].join("\n");
  return { subject, body };
}

async function listNotificationsJson(): Promise<Notification[]> {
  try {
    const raw = await fs.readFile(join(DATA_ROOT, FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Notification[]) : [];
  } catch {
    return [];
  }
}

export async function listNotifications(): Promise<Notification[]> {
  if (dbConfigured()) {
    const rows = await dbQuery<{ data: Notification }>(
      `SELECT data FROM notifications ORDER BY created_at`,
    );
    return rows.map((r) => r.data);
  }
  return listNotificationsJson();
}

async function saveNotification(record: Notification): Promise<void> {
  if (dbConfigured()) {
    await dbQuery(
      `INSERT INTO notifications (id, data, created_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO NOTHING`,
      [record.id, JSON.stringify(record)],
    );
    return;
  }
  await fs.mkdir(DATA_ROOT, { recursive: true });
  const all = await listNotificationsJson();
  all.push(record);
  const file = join(DATA_ROOT, FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(all, null, 2));
  await fs.rename(tmp, file);
}

async function sendViaResend(email: string, subject: string, body: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: process.env.NOTIFY_FROM, to: email, subject, text: body }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${detail.slice(0, 200)}`);
  }
}

/**
 * Record (and, when a provider is configured, send) the email for one
 * completed run. The caller decides via decideEmailNotification; this
 * function only refuses the cases that can never email (no address, or
 * a regression-only monitor with a non-regression run) so a direct
 * caller cannot bypass the policy. Returns null when nothing was
 * recorded; otherwise the record. Delivery failure is a recorded
 * "failed" row, never a throw.
 */
export async function notifyRegression(input: {
  monitorId: string;
  monitorUrl: string;
  email: string | null;
  regressionOnly: boolean;
  regression: boolean;
  info: RunRegression;
  scanId: string;
  reportUrl: string;
}): Promise<Notification | null> {
  if (!input.email) return null;
  if (input.regressionOnly && !input.regression) return null;
  const { subject, body } = renderMonitorEmail({
    monitorUrl: input.monitorUrl,
    info: input.info,
    reportUrl: input.reportUrl,
  });
  const record: Notification = {
    id: randomUUID(),
    monitorId: input.monitorId,
    scanId: input.scanId,
    email: input.email,
    subject,
    body,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  if (process.env.RESEND_API_KEY && process.env.NOTIFY_FROM) {
    try {
      await sendViaResend(record.email, subject, body);
      record.status = "sent";
    } catch (err) {
      record.status = "failed";
      record.error = String((err as Error).message ?? err).slice(0, 500);
    }
  }
  await saveNotification(record);
  return record;
}
