/**
 * Early-access waitlist for continuous monitoring (Phase 0 step 3 of the
 * path-to-release plan; endpoint + form ported from the prototype).
 *
 * Production (DATABASE_URL set, e.g. Neon at deploy): Postgres via
 * lib/db.ts — the `waitlist` table is part of that schema. Local /
 * private preview (no DATABASE_URL): a JSON file under PRELAUNCH_DATA_DIR
 * (default .data/), same convention as lib/store.ts. Same interface
 * either way.
 *
 * No email is sent — this only captures the address. The landing-page
 * copy says exactly that (early access, in signup order); it does NOT
 * promise a launch-announcement email, because nothing sends one.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dbConfigured, dbQuery } from "./db.ts";

export type WaitlistSource = "landing" | "report";

export interface WaitlistEntry {
  email: string;
  source: WaitlistSource;
  /** The URL that was scanned, when signup came from a report page. */
  url?: string;
  createdAt: string;
}

const DATA_DIR = process.env.PRELAUNCH_DATA_DIR ?? join(process.cwd(), ".data");
const FILE = "waitlist.json";

/** Small, fail-closed email check: one @, a dot in the domain, sane length. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

function filePath(): string {
  return join(DATA_DIR, FILE);
}

async function listWaitlistJson(): Promise<WaitlistEntry[]> {
  try {
    const raw = await fs.readFile(filePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WaitlistEntry[]) : [];
  } catch {
    return [];
  }
}

export async function listWaitlist(): Promise<WaitlistEntry[]> {
  if (dbConfigured()) {
    const rows = await dbQuery<{
      email: string;
      source: WaitlistSource;
      url: string | null;
      created_at: Date;
    }>(`SELECT email, source, url, created_at FROM waitlist ORDER BY created_at`);
    return rows.map((r) => ({
      email: r.email,
      source: r.source,
      ...(r.url ? { url: r.url } : {}),
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  return listWaitlistJson();
}

/** Read-side check: is this (already normalized) address on the list? */
export async function hasWaitlistEmail(email: string): Promise<boolean> {
  if (dbConfigured()) {
    const rows = await dbQuery<{ ok: number }>(
      `SELECT 1 AS ok FROM waitlist WHERE email = $1 LIMIT 1`,
      [email],
    );
    return rows.length > 0;
  }
  const entries = await listWaitlistJson();
  return entries.some((e) => e.email === email);
}

/**
 * Add an address to the list. Idempotent: re-adding the same address
 * (callers pass it through normalizeEmail, so case/space variants
 * collapse) reports `created: false` instead of duplicating the row.
 * Returns the total signup count after the call.
 */
export async function saveWaitlistEmail(input: {
  email: string;
  source: WaitlistSource;
  url?: string;
}): Promise<{ created: boolean; total: number }> {
  if (dbConfigured()) {
    const rows = await dbQuery<{ email: string }>(
      `INSERT INTO waitlist (email, source, url) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING email`,
      [input.email, input.source, input.url ?? null],
    );
    const totalRows = await dbQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM waitlist`,
    );
    return { created: rows.length > 0, total: Number(totalRows[0]?.count ?? 0) };
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  const entries = await listWaitlistJson();
  if (entries.some((e) => e.email === input.email)) {
    return { created: false, total: entries.length };
  }
  const entry: WaitlistEntry = {
    email: input.email,
    source: input.source,
    ...(input.url ? { url: input.url } : {}),
    createdAt: new Date().toISOString(),
  };
  entries.push(entry);
  const file = filePath();
  // Write-then-rename, same as lib/store.ts, so readers never see a
  // half-written file.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2));
  await fs.rename(tmp, file);
  return { created: true, total: entries.length };
}
