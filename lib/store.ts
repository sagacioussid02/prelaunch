/**
 * Persistence layer — same interface, two backends (issue #3).
 *
 * Scans and monitors:
 * - DATABASE_URL set (Neon at deploy): Postgres via lib/db.ts, which is
 *   authoritative — errors propagate instead of falling back, because the
 *   serverless filesystem is ephemeral and a quiet fallback loses data.
 * - DATABASE_URL unset: the original JSON file store under
 *   PRELAUNCH_DATA_DIR (default ./.data) — local dev and
 *   scripts/test-scan.ts need no infra.
 *
 * Screenshots:
 * - BLOB_READ_WRITE_TOKEN set: Vercel Blob (private), keyed
 *   `shots/{scanId}-{name}.jpg`.
 * - Unset: JPEG files under ./.data/shots, as before.
 * The two switches are independent on purpose: scans become durable with
 * DATABASE_URL alone, screenshots with the Blob token alone.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";
import type { ScanResult } from "../lib/checks/types.ts";
import { dbConfigured, dbQuery } from "./db.ts";

const DATA_DIR = process.env.PRELAUNCH_DATA_DIR ?? join(process.cwd(), ".data");

export function blobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/* ---------------- scans ---------------- */

async function pathFor(id: string): Promise<string> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("bad scan id");
  return join(DATA_DIR, `${id}.json`);
}

export async function saveScan(result: ScanResult): Promise<void> {
  if (dbConfigured()) {
    await dbQuery(
      `INSERT INTO scans (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [result.id, JSON.stringify(result)],
    );
    return;
  }
  const file = await pathFor(result.id);
  // Write-then-rename so pollers never read a half-written file.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(result));
  await fs.rename(tmp, file);
}

export async function getScan(id: string): Promise<ScanResult | null> {
  if (dbConfigured()) {
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    const rows = await dbQuery<{ data: ScanResult }>(
      `SELECT data FROM scans WHERE id = $1`,
      [id],
    );
    return rows[0]?.data ?? null;
  }
  try {
    const raw = await fs.readFile(await pathFor(id), "utf8");
    return JSON.parse(raw) as ScanResult;
  } catch {
    return null;
  }
}

export const DATA_ROOT = DATA_DIR;

/* ---------------- screenshots ---------------- */

function shotBlobPath(id: string, name: string): string {
  if (!/^[a-z0-9-]+$/i.test(id) || !/^[a-z]+$/.test(name)) throw new Error("bad shot id");
  return `shots/${id}-${name}.jpg`;
}

async function shotPath(id: string, name: string): Promise<string> {
  if (!/^[a-z0-9-]+$/i.test(id) || !/^[a-z]+$/.test(name)) throw new Error("bad shot id");
  const dir = join(DATA_DIR, "shots");
  await fs.mkdir(dir, { recursive: true });
  return join(dir, `${id}-${name}.jpg`);
}

export async function saveShot(id: string, name: string, data: Buffer): Promise<void> {
  if (blobConfigured()) {
    await put(shotBlobPath(id, name), data, {
      access: "private",
      contentType: "image/jpeg",
      addRandomSuffix: false,
    });
    return;
  }
  await fs.writeFile(await shotPath(id, name), data);
}

export async function getShot(id: string, name: string): Promise<Buffer | null> {
  if (blobConfigured()) {
    try {
      const res = await get(shotBlobPath(id, name), { access: "private" });
      if (!res || res.statusCode !== 200) return null;
      return Buffer.from(await new Response(res.stream).arrayBuffer());
    } catch {
      return null;
    }
  }
  try {
    return await fs.readFile(await shotPath(id, name));
  } catch {
    return null;
  }
}

/* ---------------- retention ---------------- */

/**
 * Retention policy (issue #3): anonymous scan reports older than
 * `retentionDays` (default 30) are deleted, with their screenshots.
 * Returns how many scans were deleted.
 *
 * `keep` holds scan ids that must survive regardless of age: the scans a
 * monitor's history and baseline point at. Deleting those would break the
 * monitor's diff (every blocker would look new) and its history links.
 * lib/retention.ts builds that set and is what the daily cron calls.
 * Safe to call in either backend mode.
 */
export async function deleteExpiredScans(
  retentionDays = 30,
  keep: ReadonlySet<string> = new Set(),
): Promise<number> {
  if (dbConfigured()) {
    const rows = await dbQuery<{ id: string }>(
      `DELETE FROM scans
       WHERE created_at < now() - make_interval(days => $1)
         AND NOT (id = ANY($2::text[]))
       RETURNING id`,
      [retentionDays, [...keep]],
    );
    if (blobConfigured()) {
      for (const { id } of rows) {
        try {
          const { blobs } = await list({ prefix: `shots/${id}-` });
          if (blobs.length) await del(blobs.map((b) => b.pathname));
        } catch (err) {
          // A failed screenshot cleanup must not fail the whole purge.
          console.error("blob cleanup failed for expired scan", id, err);
        }
      }
    }
    return rows.length;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(DATA_DIR);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (keep.has(entry.slice(0, -".json".length))) continue;
    const file = join(DATA_DIR, entry);
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(file);
        deleted++;
      }
    } catch {
      // Raced with another delete or a write — skip.
    }
  }
  try {
    const shotsDir = join(DATA_DIR, "shots");
    const keepList = [...keep];
    for (const entry of await fs.readdir(shotsDir)) {
      // Shot files are `{scanId}-{name}.jpg`; keep those of protected scans.
      if (keepList.some((id) => entry.startsWith(`${id}-`))) continue;
      const file = join(shotsDir, entry);
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs < cutoff) await fs.unlink(file);
      } catch {
        // Skip, same as above.
      }
    }
  } catch {
    // No shots directory — nothing to clean.
  }
  return deleted;
}

export function newScanId(): string {
  // 128-bit random IDs (security review 2026-10-18, MEDIUM #10): report pages
  // are public by design, so IDs must not be enumerable.
  return randomUUID();
}
