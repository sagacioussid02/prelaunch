/**
 * Ownership proof helpers (Phase 0 step 4, ported from the local
 * prototype's lib/ownership.ts).
 *
 * Domain verification is the self-serve ownership path for monitors:
 * the owner asks for a claim token (POST /api/monitor/[id]/claim),
 * publishes it as the entire body of
 * https://<their site>/.well-known/prelaunch-check.txt, then calls
 * verify (POST /api/monitor/[id]/verify). The server fetches that file
 * through the same SSRF-guarded fetcher the scanner uses and marks the
 * monitor verified only when the body matches the token exactly.
 * Publishing a file on the site proves control of the site; knowing
 * the monitor id alone does not.
 *
 * The per-monitor deploy secret is NOT in this module: the repo model
 * predates the prototype here and is stronger — the deploy token is
 * stored as a SHA-256 hash and checked timing-safely in lib/monitor.ts
 * (verifyToken), never in plaintext. These helpers cover the claim
 * token (single-use proof, rotated on re-claim) and cron auth.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export const VERIFICATION_PATH = "/.well-known/prelaunch-check.txt";
export const VERIFICATION_TIMEOUT_MS = 10_000;

export function generateSecret(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

/** Timing-safe string compare that fails closed on length mismatch. */
export function secretsEqual(provided: string | null, expected: string | null): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the fetched well-known file body proves ownership. */
export function verificationBodyMatches(body: string, token: string): boolean {
  return body.trim() === token;
}

/**
 * Vercel cron auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 * Fails closed when CRON_SECRET is unset — an unconfigured cron endpoint
 * must not become a free way to burn scan quota.
 */
export function cronSecretValid(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
