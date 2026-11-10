/**
 * Production persistence for scans, monitors, the waitlist, monitor
 * notifications (issue #3, Phase 0 steps 1, 3 and 4) and the scan request
 * log (issue #6, Phase 1; lib/scanlog.ts).
 *
 * Ported from the local prototype's lib/db.ts. When DATABASE_URL is set
 * (Neon Postgres at deploy), Postgres is the authoritative store for scans
 * and monitors, behind the existing lib/store.ts / lib/monitor.ts
 * interfaces, and for waitlist signups behind lib/waitlist.ts. When it is
 * unset, callers fall back to the JSON-file store — local dev and
 * scripts/test-scan.ts need no infra.
 *
 * Deliberate choice: when DATABASE_URL IS set, a connection failure
 * propagates as an error instead of silently falling back to files,
 * because on Vercel the filesystem is ephemeral and a quiet fallback
 * would lose scan reports and monitor baselines.
 *
 * Screenshots are NOT stored here — they go to Vercel Blob when
 * BLOB_READ_WRITE_TOKEN is set (see lib/store.ts).
 *
 * Schema is created lazily on first use (CREATE TABLE IF NOT EXISTS), so
 * no separate migration step is needed for the Neon database.
 */

import { Pool } from "pg";

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function dbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Neon requires TLS; `pg` negotiates it from the connection string.
      max: 5,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (err) => {
      // Idle-client errors must not crash the function silently.
      console.error("pg pool error", err);
    });
  }
  return pool;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = getPool();
      await client.query(`
        CREATE TABLE IF NOT EXISTS scans (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS monitors (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS waitlist (
          email TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('landing', 'report')),
          url TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS scan_requests (
          id BIGSERIAL PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL DEFAULT now(),
          ip_hash TEXT NOT NULL,
          host TEXT,
          mode TEXT,
          outcome TEXT NOT NULL,
          scan_id TEXT
        );
        CREATE INDEX IF NOT EXISTS scan_requests_at_idx ON scan_requests (at);
        CREATE INDEX IF NOT EXISTS scan_requests_ip_hash_idx ON scan_requests (ip_hash, at);
        CREATE INDEX IF NOT EXISTS scan_requests_host_idx ON scan_requests (host, at);
      `);
    })();
  }
  return schemaReady;
}

export async function dbQuery<T = unknown>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const res = await getPool().query(text, params);
  return res.rows as T[];
}
