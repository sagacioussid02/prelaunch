/**
 * Deploy monitoring.
 *
 * A monitor watches one production URL. A deploy webhook (Vercel, GitHub
 * Actions, curl…) calls /api/monitor/{id}/deploy?token=…; that runs a passive
 * audit, diffs its blockers against the previous run and records an alert for
 * any NEW blocker. If an alert webhook (Slack/Discord/generic JSON) is
 * configured, it is notified too. Storage is the same JSON-file prototype
 * store; swap for Postgres with the rest of lib/store.ts.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DATA_ROOT, getScan, newScanId } from "./store.ts";
import { startScanJob } from "./jobs.ts";
import { normalizeUrl } from "./scanner.ts";
import { assertSafeHostname } from "./ssrf.ts";
import { fetchWithTimeout } from "./checks/types.ts";
import type { Finding } from "./checks/types.ts";

export const MONITOR_COOLDOWN_MS = 60_000;
const MAX_RUNS = 50;

export interface MonitorRun {
  scanId: string;
  at: string;
  trigger: "baseline" | "deploy" | "manual";
  score: number;
  grade: string;
  blockers: number;
  warnings: number;
  /** Blockers not present in the previous run */
  newBlockers: Array<Pick<Finding, "checkId" | "title" | "location" | "fix">>;
  alertSent: boolean;
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
}

/** What the public dashboard may see (no secret hash, no webhook URL). */
export interface PublicMonitor {
  id: string;
  url: string;
  createdAt: string;
  running: boolean;
  hasAlertWebhook: boolean;
  runs: MonitorRun[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function fileFor(id: string): Promise<string> {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("bad monitor id");
  const dir = join(DATA_ROOT, "monitors");
  await fs.mkdir(dir, { recursive: true });
  return join(dir, `${id}.json`);
}

async function load(id: string): Promise<StoredMonitor | null> {
  try {
    return JSON.parse(await fs.readFile(await fileFor(id), "utf8")) as StoredMonitor;
  } catch {
    return null;
  }
}

async function save(m: StoredMonitor): Promise<void> {
  const file = await fileFor(m.id);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(m));
  await fs.rename(tmp, file);
}

function toPublic(m: StoredMonitor): PublicMonitor {
  return {
    id: m.id,
    url: m.url,
    createdAt: m.createdAt,
    running: m.running,
    hasAlertWebhook: !!m.alertWebhook,
    runs: m.runs,
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
): Promise<{ id: string; token: string; url: string }> {
  const url = normalizeUrl(rawUrl);
  await assertSafeHostname(new URL(url).hostname);
  const hook = alertWebhook?.trim() ? await assertWebhook(alertWebhook.trim()) : undefined;
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
  });
  return { id, token, url };
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

export type RunStart = { ok: true; scanId: string } | { ok: false; reason: "cooldown" | "busy" | "missing"; retryInMs?: number };

/** Starts an audit in the background; the result is diffed and recorded when it finishes. */
export async function runMonitor(id: string, trigger: "deploy" | "manual", baseUrl: string): Promise<RunStart> {
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

  const job = await startScanJob(m.url, "passive", scanId);
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
      fresh.runs = [...fresh.runs, run].slice(-MAX_RUNS);
    }
    await save(fresh);
  });
  return { ok: true, scanId };
}
