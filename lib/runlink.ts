/**
 * Signed, short-lived "Run now" grants for the monitor dashboard
 * (issue #6, Phase 1).
 *
 * POST /api/monitor/{id}/deploy?manual=1 used to need nothing but the
 * monitor id. It now needs either the monitor's deploy token or a grant
 * minted here: `{exp}.{sig}`, where sig = HMAC-SHA256(PRELAUNCH_LINK_SECRET,
 * "run:{monitorId}:{exp}") and exp is a unix time in seconds. The grant is
 * bound to one monitor and expires after RUN_GRANT_TTL_SECONDS.
 *
 * Fails closed: with PRELAUNCH_LINK_SECRET unset no grant is minted and
 * none verifies, so only the deploy token can start a manual run.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const RUN_GRANT_TTL_SECONDS = 60 * 60;

function secret(): string | null {
  return process.env.PRELAUNCH_LINK_SECRET || null;
}

function sign(key: string, monitorId: string, exp: number): string {
  return createHmac("sha256", key).update(`run:${monitorId}:${exp}`).digest("base64url");
}

/** Mints a grant for one monitor, or null when PRELAUNCH_LINK_SECRET is unset. */
export function mintRunGrant(
  monitorId: string,
  nowMs = Date.now(),
  ttlSeconds = RUN_GRANT_TTL_SECONDS,
): string | null {
  const key = secret();
  if (!key) return null;
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  return `${exp}.${sign(key, monitorId, exp)}`;
}

/** True only for an unexpired grant minted for this monitor with the current secret. */
export function verifyRunGrant(monitorId: string, grant: string | null, nowMs = Date.now()): boolean {
  const key = secret();
  if (!key || !grant) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{20,100})$/.exec(grant);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 <= nowMs) return false;
  const expected = Buffer.from(sign(key, monitorId, exp));
  const provided = Buffer.from(m[2]);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
