/**
 * Scan request log for abuse handling (issue #6, Phase 1).
 *
 * Every POST /api/scan is recorded with a hashed client IP, the target
 * host, the time, the mode and what happened (accepted, or which limit
 * stopped it). The raw IP is never stored or logged.
 *
 * - Always: one JSON line on stdout (`event: "scan_request"`), which lands
 *   in the Vercel function logs.
 * - DATABASE_URL set: also a row in `scan_requests` (lib/db.ts), so abuse
 *   can be queried by ip_hash or host. Rows older than 30 days are deleted
 *   by the daily retention cron (lib/retention.ts).
 * Logging is best-effort: a failed insert never fails the scan request.
 *
 * IP hashing: HMAC-SHA256 keyed with PRELAUNCH_IP_HASH_SALT, truncated to
 * 16 hex chars. Without the salt an IPv4 hash is trivially reversible, so
 * production must set it; when unset we still hash (unkeyed) and warn once.
 */

import { createHash, createHmac } from "node:crypto";
import { dbConfigured, dbQuery } from "./db.ts";

export type ScanRequestOutcome =
  | "accepted"
  | "rate_limited_ip"
  | "rate_limited_host"
  | "rate_limited_global"
  | "busy"
  | "invalid";

export interface ScanRequestLog {
  at: string;
  ipHash: string;
  host: string | null;
  mode: string | null;
  outcome: ScanRequestOutcome;
  scanId: string | null;
}

let warnedNoSalt = false;

export function hashIp(ip: string): string {
  const salt = process.env.PRELAUNCH_IP_HASH_SALT;
  if (!salt) {
    if (!warnedNoSalt) {
      warnedNoSalt = true;
      console.warn("scanlog: PRELAUNCH_IP_HASH_SALT is unset; IP hashes are unkeyed");
    }
    return createHash("sha256").update(`prelaunch-ip:${ip}`).digest("hex").slice(0, 16);
  }
  return createHmac("sha256", salt).update(ip).digest("hex").slice(0, 16);
}

export async function logScanRequest(entry: {
  ip: string;
  host?: string | null;
  mode?: string | null;
  outcome: ScanRequestOutcome;
  scanId?: string | null;
}): Promise<ScanRequestLog> {
  const record: ScanRequestLog = {
    at: new Date().toISOString(),
    ipHash: hashIp(entry.ip),
    host: entry.host ?? null,
    mode: entry.mode ?? null,
    outcome: entry.outcome,
    scanId: entry.scanId ?? null,
  };
  console.log(JSON.stringify({ event: "scan_request", ...record }));
  if (dbConfigured()) {
    try {
      await dbQuery(
        `INSERT INTO scan_requests (at, ip_hash, host, mode, outcome, scan_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [record.at, record.ipHash, record.host, record.mode, record.outcome, record.scanId],
      );
    } catch (err) {
      console.error("scanlog: insert failed", err);
    }
  }
  return record;
}

/** Retention for the log itself (daily cron). Returns rows deleted; 0 without Postgres. */
export async function deleteExpiredScanRequests(retentionDays = 30): Promise<number> {
  if (!dbConfigured()) return 0;
  const rows = await dbQuery<{ id: string }>(
    `DELETE FROM scan_requests WHERE at < now() - make_interval(days => $1) RETURNING id`,
    [retentionDays],
  );
  return rows.length;
}
