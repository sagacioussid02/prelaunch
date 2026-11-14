/**
 * Prelaunch keys for the GitHub Action (action/, POST /api/ci/scan).
 *
 * A key is what a private repository's workflow sends to run CI scans.
 * It belongs to an email address; the key itself carries no plan. At
 * scan time the route resolves the email's plan through billing
 * (planForEmailAsync), so a key stops working the moment the Pro
 * subscription lapses and starts again if it is renewed — no key
 * rotation needed for billing changes.
 *
 * Format: "plk_" + 43 base64url chars (32 random bytes). Only a SHA-256
 * hash of the key is stored; the raw key is shown once, at issue time
 * (scripts/ci-key.ts). Keys are high-entropy, so an unsalted hash is
 * enough to make a leaked store useless, and lookup is a single indexed
 * equality on the hash.
 *
 * Persistence follows the dual-backend pattern: a `ci_keys` table in
 * lib/db.ts when DATABASE_URL is set, a JSON file under
 * PRELAUNCH_DATA_DIR otherwise.
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { dbConfigured, dbQuery } from "./db.ts";

export const CI_KEY_PREFIX = "plk_";
const KEY_PATTERN = /^plk_[A-Za-z0-9_-]{43}$/;

export interface CiKey {
  /** Public id, safe to log and to show in lists ("ck_" + 12 hex). */
  id: string;
  /** SHA-256 hex of the raw key. */
  keyHash: string;
  email: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Pure: does this string look like a Prelaunch key? */
export function looksLikeCiKey(raw: string): boolean {
  return KEY_PATTERN.test(raw);
}

export function hashCiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateCiKey(): string {
  return CI_KEY_PREFIX + randomBytes(32).toString("base64url");
}

function dataDir(): string {
  return process.env.PRELAUNCH_DATA_DIR ?? join(process.cwd(), ".data");
}
function filePath(): string {
  return join(dataDir(), "ci-keys.json");
}

async function readJson(): Promise<CiKey[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath(), "utf8"));
    return Array.isArray(parsed) ? (parsed as CiKey[]) : [];
  } catch {
    return [];
  }
}
async function writeJson(all: CiKey[]): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(filePath(), JSON.stringify(all, null, 2));
}

interface CiKeyRow {
  id: string;
  key_hash: string;
  email: string;
  label: string | null;
  created_at: Date;
  revoked_at: Date | null;
}
function rowToKey(r: CiKeyRow): CiKey {
  return {
    id: r.id,
    keyHash: r.key_hash,
    email: r.email,
    label: r.label,
    createdAt: new Date(r.created_at).toISOString(),
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
  };
}
const COLUMNS = "id, key_hash, email, label, created_at, revoked_at";

/** Issue a key for an email. Returns the raw key (show it once) and the stored record. */
export async function issueCiKey(
  email: string,
  label: string | null = null,
): Promise<{ key: string; record: CiKey }> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("invalid email");
  const key = generateCiKey();
  const record: CiKey = {
    id: "ck_" + randomBytes(6).toString("hex"),
    keyHash: hashCiKey(key),
    email: normalized,
    label: label?.trim() || null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  if (dbConfigured()) {
    await dbQuery(
      `INSERT INTO ci_keys (id, key_hash, email, label, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [record.id, record.keyHash, record.email, record.label, record.createdAt],
    );
  } else {
    const all = await readJson();
    all.push(record);
    await writeJson(all);
  }
  return { key, record };
}

/** Look up an active (not revoked) key by its raw value. Null when unknown, malformed or revoked. */
export async function findActiveCiKey(raw: string): Promise<CiKey | null> {
  if (!looksLikeCiKey(raw)) return null;
  const hash = hashCiKey(raw);
  let found: CiKey | null;
  if (dbConfigured()) {
    const rows = await dbQuery<CiKeyRow>(`SELECT ${COLUMNS} FROM ci_keys WHERE key_hash = $1`, [hash]);
    found = rows[0] ? rowToKey(rows[0]) : null;
  } else {
    found = (await readJson()).find((k) => k.keyHash === hash) ?? null;
  }
  return found && !found.revokedAt ? found : null;
}

export async function listCiKeys(email?: string): Promise<CiKey[]> {
  const key = email?.trim().toLowerCase();
  if (dbConfigured()) {
    const rows = key
      ? await dbQuery<CiKeyRow>(`SELECT ${COLUMNS} FROM ci_keys WHERE email = $1 ORDER BY created_at`, [key])
      : await dbQuery<CiKeyRow>(`SELECT ${COLUMNS} FROM ci_keys ORDER BY created_at`);
    return rows.map(rowToKey);
  }
  const all = await readJson();
  return key ? all.filter((k) => k.email === key) : all;
}

/** Revoke by public id. Returns false when no such key exists. Idempotent. */
export async function revokeCiKey(id: string): Promise<boolean> {
  if (dbConfigured()) {
    const rows = await dbQuery<{ id: string }>(
      `UPDATE ci_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
  const all = await readJson();
  const k = all.find((x) => x.id === id);
  if (!k) return false;
  k.revokedAt ??= new Date().toISOString();
  await writeJson(all);
  return true;
}
