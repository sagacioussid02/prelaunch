/**
 * Process setup that must run before the scanner modules load (main.ts
 * imports this first): lib/store.ts reads PRELAUNCH_DATA_DIR at import time.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor } from "apify";

// The scanner's storage falls back to Postgres / Vercel Blob when these
// are set. An Actor run keeps nothing outside Apify storage, so make sure
// they can't be picked up from the environment.
for (const k of ["DATABASE_URL", "POSTGRES_URL", "BLOB_READ_WRITE_TOKEN"]) delete process.env[k];

// The loopback escape hatch exists for local tests only; never on Apify.
if (Actor.isAtHome()) delete process.env.PRELAUNCH_ALLOW_LOOPBACK;

// Screenshots are written here first, then copied to the run's key-value store.
process.env.PRELAUNCH_DATA_DIR ??= join(tmpdir(), "prelaunch-data");
mkdirSync(process.env.PRELAUNCH_DATA_DIR, { recursive: true });
