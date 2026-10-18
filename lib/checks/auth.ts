/**
 * Auth checks (category weight: 25).
 *
 * All three are FULL-mode only in the prototype: they involve probing API
 * routes or reasoning about Supabase keys, which crosses into active
 * testing. Anonymous scans skip them entirely (see the revised scan-toggle
 * stance, 2026-10-16). All probes are single-request, non-intrusive.
 */

import type { Check, Finding, ScanContext } from "./types.ts";
import { cachedGet, extractScriptSrcs } from "./types.ts";

const CATEGORY = "Authentication";
const WEIGHT = 25;

const COMMON_API_PATHS = [
  "/api/admin",
  "/api/users",
  "/api/user",
  "/api/config",
  "/api/settings",
  "/api/debug",
  "/api/internal",
  "/api/keys",
];

/** Response bodies that smell like data that should sit behind auth. */
const SENSITIVE_SHAPES = [
  /"email"\s*:/,
  /"password"\s*:/,
  /"users"\s*:\s*\[/,
  /"admin"\s*:\s*true/,
  /"role"\s*:\s*"(?:admin|owner|superuser)"/,
  /"secret"/,
];

const supabaseAnonExposed: Check = {
  id: "supabase-anon-exposed",
  name: "Supabase key review",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const home = await cachedGet(ctx, ctx.target + "/");
    if (home.status === 0 || !home.body) return findings;

    const chunks = extractScriptSrcs(home.body, ctx.target).slice(0, 12);
    const jwtRe = /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
    for (const chunk of chunks) {
      const js = await cachedGet(ctx, chunk);
      if (js.status !== 200 || !js.body) continue;
      jwtRe.lastIndex = 0;
      const m = jwtRe.exec(js.body);
      if (m && js.body.includes("supabase")) {
        findings.push({
          checkId: this.id,
          severity: "warning",
          title: "Supabase key present in client bundle — verify RLS policies",
          location: chunk,
          fix: "An anon key is fine IF Row Level Security is on; confirm every table has restrictive policies.",
          fixLink: "https://supabase.com/docs/guides/database/postgres/row-level-security",
        });
        break;
      }
    }
    return findings;
  },
};

const unprotectedApi: Check = {
  id: "unprotected-api",
  name: "Unprotected API routes",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const path of COMMON_API_PATHS) {
      const res = await cachedGet(ctx, ctx.target + path);
      if (res.status !== 200) continue;
      const body = res.body.trim();
      if (!body.startsWith("{") && !body.startsWith("[")) continue;
      if (SENSITIVE_SHAPES.some((re) => re.test(body))) {
        findings.push({
          checkId: this.id,
          severity: "blocker",
          title: `${path} returns sensitive data without authentication`,
          location: ctx.target + path,
          fix: "Require a session/token on this route (middleware or per-route check).",
        });
      }
    }
    return findings;
  },
};

const previewProtection: Check = {
  id: "preview-protection",
  name: "Preview deployment protection",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const home = await cachedGet(ctx, ctx.target + "/");
    if (home.status === 0) return [];
    const hasVercelHeaders =
      Object.keys(home.headers).some((h) => h.startsWith("x-vercel-")) ||
      home.headers["server"] === "Vercel";
    if (!hasVercelHeaders) return []; // not a Vercel app — heuristic doesn't apply
    // Best-effort heuristic: preview deployments on vercel.app subdomains
    // should carry Deployment Protection; a bare 200 on a -git- URL hints
    // it's off. We can only flag what we can observe from headers.
    const looksLikePreview = /-git-[a-z0-9-]+\.vercel\.app$/.test(new URL(ctx.target).host);
    if (looksLikePreview && !home.headers["x-vercel-protection-bypass"]) {
      return [
        {
          checkId: this.id,
          severity: "warning",
          title: "Possible preview deployment without Deployment Protection",
          location: ctx.target,
          fix: "Enable Deployment Protection for preview deployments in Vercel project settings.",
          fixLink: "https://vercel.com/docs/security/deployment-protection",
        },
      ];
    }
    return [];
  },
};

export const authChecks: Check[] = [supabaseAnonExposed, unprotectedApi, previewProtection];
