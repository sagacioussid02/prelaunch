/**
 * Secrets exposure checks (category weight: 40) — the signature category.
 *
 * Modes (per revised scan-toggle stance):
 * - client-bundle-secrets: FULL only. Downloads shipped JS chunks and
 *   pattern-matches key shapes + entropy. This is the check that makes
 *   anonymous scans risky, so it sits behind ownership proof.
 * - exposed-env:           passive. A single GET of /.env is read-only
 *   against a public resource — but a leaked .env is also something the
 *   owner wants flagged, and it produces no findings on healthy sites.
 * - sourcemap-leak:        passive. GETs each chunk URL + ".map"; many
 *   sourcemaps are deliberately public, so this is a warning, not a blocker.
 */

import type { Check, Finding, ScanContext } from "./types.ts";
import { cachedGet, entropy, extractScriptSrcs } from "./types.ts";

const CATEGORY = "Secrets exposure";
const WEIGHT = 40;

/** Key-shape patterns → human label. Tuned to minimize false positives. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp; minEntropy: number }> = [
  // Stripe live secret keys (sk_live_...) — never in a browser bundle.
  { name: "Stripe live secret key", re: /sk_live_[A-Za-z0-9]{16,}/g, minEntropy: 3.5 },
  // Supabase service_role JWT (service keys have full DB access).
  {
    name: "Supabase service-role JWT",
    re: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    minEntropy: 4.0,
  },
  // AWS access key IDs.
  { name: "AWS access key ID", re: /AKIA[0-9A-Z]{16}/g, minEntropy: 0 },
  // NEXT_PUBLIC_ envs holding secret-looking values.
  {
    name: "NEXT_PUBLIC_ env with secret-like value",
    re: /NEXT_PUBLIC_[A-Z0-9_]{3,}["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{20,})["']/g,
    minEntropy: 4.2,
  },
  // Generic long quoted tokens assigned to *secret*/*key*/*token* vars.
  {
    name: "Hardcoded secret-like token",
    re: /(?:secret|api[_-]?key|private[_-]?key|token)["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{32,})["']/gi,
    minEntropy: 4.3,
  },
];

const clientBundleSecrets: Check = {
  id: "client-bundle-secrets",
  name: "Client bundle secret scan",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const home = await cachedGet(ctx, ctx.target + "/");
    if (home.status === 0 || !home.body) return findings;

    const chunks = extractScriptSrcs(home.body, ctx.target).slice(0, 12); // cap: gentle
    let skipped = 0;
    for (const chunk of chunks) {
      const js = await cachedGet(ctx, chunk);
      if (js.status !== 200 || !js.body) {
        skipped++;
        continue;
      }
      for (const { name, re, minEntropy } of SECRET_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(js.body)) !== null) {
          const candidate = m[1] ?? m[0];
          if (candidate.length >= 20 && entropy(candidate) < minEntropy) continue; // lookalike
          findings.push({
            checkId: this.id,
            severity: "blocker",
            title: `${name} found in shipped JS`,
            location: chunk,
            fix: "Move it to a server-only env var or API route; rotate the key now.",
            fixLink: "https://nextjs.org/docs/app/building-your-application/configuring/environment-variables#bundling-environment-variables-for-the-browser",
          });
          break; // one finding per pattern per chunk is enough
        }
      }
    }
    if (skipped > 0) {
      findings.push({
        checkId: this.id,
        severity: "info",
        title: `Could not fetch ${skipped} of ${chunks.length} JS chunks — bundle analysis may be incomplete`,
        location: ctx.target,
        fix: "Re-run the scan; unfetched chunks were not analyzed for secrets.",
      });
    }
    return findings;
  },
};

const exposedEnv: Check = {
  id: "exposed-env",
  name: "Exposed .env files",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const path of ["/.env", "/.env.local", "/.env.production"]) {
      const res = await cachedGet(ctx, ctx.target + path);
      if (res.status === 200 && /^[A-Z_]+\s*=/m.test(res.body)) {
        findings.push({
          checkId: this.id,
          severity: "blocker",
          title: `${path} is publicly reachable and looks like an env file`,
          location: ctx.target + path,
          fix: "Block dotfiles at the edge (Vercel rewrites/headers) and rotate every key inside.",
        });
      }
    }
    return findings;
  },
};

const sourcemapLeak: Check = {
  id: "sourcemap-leak",
  name: "Sourcemap exposure",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const home = await cachedGet(ctx, ctx.target + "/");
    if (home.status === 0 || !home.body) return findings;

    const chunks = extractScriptSrcs(home.body, ctx.target).slice(0, 12);
    for (const chunk of chunks) {
      const map = await cachedGet(ctx, chunk + ".map");
      if (map.status === 200 && map.body.includes("sourcesContent")) {
        findings.push({
          checkId: this.id,
          severity: "warning",
          title: "Sourcemap exposes original source",
          location: chunk + ".map",
          fix: "Ship sourcemaps to an error-tracking service instead (e.g. Sentry), not the public web root.",
        });
      }
    }
    return findings;
  },
};

export const secretChecks: Check[] = [clientBundleSecrets, exposedEnv, sourcemapLeak];
