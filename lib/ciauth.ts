/**
 * Who may run CI scans, and on which tier (POST /api/ci/scan).
 *
 * Two credentials, both sent as `Authorization: Bearer …`:
 * - A Prelaunch key ("plk_…", lib/cikeys.ts): the paid tier. The key's
 *   email must resolve to Pro through billing (planForEmailAsync), so a
 *   lapsed subscription turns the key off without revoking it. Works for
 *   any repository, private included.
 * - A GitHub Actions OIDC token (lib/github-oidc.ts): the free tier, for
 *   PUBLIC repositories only. Private and internal repositories get 402
 *   with a pointer to keys.
 *
 * Each tier has its own hourly limit, keyed on the credential rather than
 * the caller's IP (GitHub's hosted runners share IPs across customers, so
 * the website's 5/hour/IP would block unrelated teams). The per-target-
 * host and global caps in lib/ratelimit.ts still apply to every CI scan,
 * exactly as they do to website scans.
 */

import { planForEmailAsync } from "./billing.ts";
import { findActiveCiKey, looksLikeCiKey } from "./cikeys.ts";
import { looksLikeJwt, verifyGithubOidcToken, type JwksFetcher } from "./github-oidc.ts";

export type CiTier = "free" | "paid";

/** Defaults; PRELAUNCH_CI_SCANS_PER_HOUR_FREE / _PAID override (read per call). */
export const DEFAULT_CI_SCANS_PER_HOUR_FREE = 20;
export const DEFAULT_CI_SCANS_PER_HOUR_PAID = 60;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
export function ciScansPerHour(tier: CiTier): number {
  return tier === "paid"
    ? envInt("PRELAUNCH_CI_SCANS_PER_HOUR_PAID", DEFAULT_CI_SCANS_PER_HOUR_PAID)
    : envInt("PRELAUNCH_CI_SCANS_PER_HOUR_FREE", DEFAULT_CI_SCANS_PER_HOUR_FREE);
}

export type CiAuthResult =
  | {
      ok: true;
      tier: CiTier;
      /** Rate-limit key for this credential, e.g. "ci:key:ck_…" or "ci:repo:123". */
      limitKey: string;
      /** For logs: key id or repository name, never the secret. */
      subject: string;
    }
  | { ok: false; status: 401 | 402; reason: string };

export const KEYS_HINT =
  "Private repositories need a Prelaunch key: add it as a repository secret and pass it to the action as api-key.";

export async function authorizeCiRequest(
  authorization: string | null,
  opts: { fetchJwks?: JwksFetcher } = {},
): Promise<CiAuthResult> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  if (!m) {
    return {
      ok: false,
      status: 401,
      reason:
        "missing credentials: give the workflow `permissions: id-token: write` (public repositories) or pass a Prelaunch key as api-key",
    };
  }
  const token = m[1];

  if (looksLikeCiKey(token)) {
    // A store error propagates: the route answers 503 rather than calling a good key bad.
    const key = await findActiveCiKey(token);
    if (!key) return { ok: false, status: 401, reason: "unknown or revoked Prelaunch key" };
    const plan = await planForEmailAsync(key.email);
    if (plan.id !== "pro") {
      return {
        ok: false,
        status: 402,
        reason: "this Prelaunch key's subscription is not active; renew Pro to keep scanning",
      };
    }
    return { ok: true, tier: "paid", limitKey: `ci:key:${key.id}`, subject: key.id };
  }

  if (looksLikeJwt(token)) {
    const v = await verifyGithubOidcToken(token, { fetchJwks: opts.fetchJwks });
    if (!v.ok) return { ok: false, status: 401, reason: `GitHub OIDC token rejected: ${v.reason}` };
    if (v.claims.repository_visibility !== "public") {
      return { ok: false, status: 402, reason: KEYS_HINT };
    }
    const repoKey = v.claims.repository_id || v.claims.repository.toLowerCase();
    return { ok: true, tier: "free", limitKey: `ci:repo:${repoKey}`, subject: v.claims.repository };
  }

  return { ok: false, status: 401, reason: "unrecognised credentials" };
}
