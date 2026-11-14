/**
 * Verifies GitHub Actions OIDC tokens (issue: paid GitHub Action).
 *
 * A workflow with `permissions: id-token: write` can ask GitHub for a
 * short-lived JWT that GitHub signs and that names the repository it was
 * issued to, including `repository_visibility`. The Action sends it to
 * POST /api/ci/scan when no Prelaunch key is configured; a valid token for
 * a PUBLIC repository is what the free tier rests on. The workflow can't
 * forge the visibility claim, unlike a flag it sends itself.
 *
 * Checks: RS256 only (no "none", no HMAC confusion), signature against
 * GitHub's published JWKS (cached 10 minutes, refetched once on an unknown
 * kid), iss exactly GitHub's issuer, aud equal to ours, exp/nbf with 60 s
 * clock skew, and a lifetime cap. Zero dependencies: node:crypto reads the
 * JWK directly.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
/** Audience the Action requests and the route requires. */
export const PRELAUNCH_OIDC_AUDIENCE = "prelaunch";

const CLOCK_SKEW_S = 60;
/** GitHub's tokens live minutes; anything claiming more than this is refused. */
const MAX_LIFETIME_S = 60 * 60;
const JWKS_TTL_MS = 10 * 60_000;

export interface GithubOidcClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  /** "owner/name" */
  repository: string;
  repository_id?: string;
  repository_owner?: string;
  /** "public" | "private" | "internal" */
  repository_visibility: string;
  ref?: string;
  sha?: string;
  event_name?: string;
  [k: string]: unknown;
}

export type OidcResult =
  | { ok: true; claims: GithubOidcClaims }
  | { ok: false; reason: string };

type Jwk = { kid?: string; kty?: string; alg?: string; [k: string]: unknown };
export type JwksFetcher = () => Promise<{ keys: Jwk[] }>;

const defaultFetcher: JwksFetcher = async () => {
  const res = await fetch(GITHUB_OIDC_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
};

let cache: { at: number; keys: Jwk[] } | null = null;

/** Test hook: forget cached keys. */
export function resetJwksCache(): void {
  cache = null;
}

async function keysFor(kid: string, fetcher: JwksFetcher): Promise<Jwk | undefined> {
  const fresh = cache && Date.now() - cache.at < JWKS_TTL_MS;
  let hit = fresh ? cache!.keys.find((k) => k.kid === kid) : undefined;
  if (!hit) {
    // Unknown kid or stale cache: refetch once (GitHub rotates keys).
    const { keys } = await fetcher();
    cache = { at: Date.now(), keys: Array.isArray(keys) ? keys : [] };
    hit = cache.keys.find((k) => k.kid === kid);
  }
  return hit;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pure-ish: does this look like a JWT (three base64url segments)? */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export async function verifyGithubOidcToken(
  token: string,
  opts: { audience?: string; fetchJwks?: JwksFetcher; now?: number } = {},
): Promise<OidcResult> {
  const audience = opts.audience ?? PRELAUNCH_OIDC_AUDIENCE;
  if (!looksLikeJwt(token)) return { ok: false, reason: "malformed token" };
  const [h, p, s] = token.split(".");
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload) return { ok: false, reason: "malformed token" };
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported alg" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "missing kid" };

  let jwk: Jwk | undefined;
  try {
    jwk = await keysFor(header.kid, opts.fetchJwks ?? defaultFetcher);
  } catch {
    return { ok: false, reason: "could not load GitHub signing keys" };
  }
  if (!jwk || jwk.kty !== "RSA") return { ok: false, reason: "unknown signing key" };

  let valid = false;
  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    valid = cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const c = payload as Partial<GithubOidcClaims>;
  if (c.iss !== GITHUB_OIDC_ISSUER) return { ok: false, reason: "wrong issuer" };
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(audience)) return { ok: false, reason: "wrong audience" };
  if (typeof c.exp !== "number" || c.exp + CLOCK_SKEW_S < now) return { ok: false, reason: "expired" };
  if (typeof c.nbf === "number" && c.nbf - CLOCK_SKEW_S > now) return { ok: false, reason: "not yet valid" };
  const issuedAt = typeof c.iat === "number" ? c.iat : typeof c.nbf === "number" ? c.nbf : now;
  if (c.exp - issuedAt > MAX_LIFETIME_S) return { ok: false, reason: "lifetime too long" };
  if (typeof c.repository !== "string" || !c.repository.includes("/")) {
    return { ok: false, reason: "missing repository claim" };
  }
  if (typeof c.repository_visibility !== "string") {
    return { ok: false, reason: "missing repository_visibility claim" };
  }
  return { ok: true, claims: c as GithubOidcClaims };
}
