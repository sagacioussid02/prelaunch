/**
 * Headers & transport checks (category weight: 20). Passive.
 * Implemented directly — no third-party API dependency.
 */

import type { Check, Finding, ScanContext } from "./types.ts";
import { cachedGet } from "./types.ts";

const CATEGORY = "Headers & transport";
const WEIGHT = 20;

const headerChecks: Array<{
  header: string;
  title: string;
  fix: string;
  fixLink?: string;
  blockerOnProduction?: boolean;
}> = [
  {
    header: "content-security-policy",
    title: "Missing Content-Security-Policy",
    fix: "Add a CSP header (start with report-only) via next.config.js headers.",
    fixLink: "https://nextjs.org/docs/app/guides/content-security-policy",
  },
  {
    header: "strict-transport-security",
    title: "Missing Strict-Transport-Security (HSTS)",
    fix: "Send Strict-Transport-Security: max-age=63072000; includeSubDomains; preload.",
    blockerOnProduction: true,
  },
  {
    header: "x-frame-options",
    title: "Missing X-Frame-Options",
    fix: "Send X-Frame-Options: DENY (or use frame-ancestors in CSP).",
  },
  {
    header: "x-content-type-options",
    title: "Missing X-Content-Type-Options",
    fix: "Send X-Content-Type-Options: nosniff.",
  },
  {
    header: "referrer-policy",
    title: "Missing Referrer-Policy",
    fix: "Send Referrer-Policy: strict-origin-when-cross-origin.",
  },
  {
    header: "permissions-policy",
    title: "Missing Permissions-Policy",
    fix: "Send Permissions-Policy to lock down camera/mic/geolocation.",
  },
];

const headersCheck: Check = {
  id: "security-headers",
  name: "Security headers",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const home = await cachedGet(ctx, ctx.target + "/");
    if (home.status === 0) {
      return [
        {
          checkId: this.id,
          severity: "blocker",
          title: "Target unreachable",
          location: ctx.target,
          fix: "Confirm the URL is correct and the site responds to HTTPS.",
        },
      ];
    }

    const isProductionHost = !/localhost|\.vercel\.app$|\.pages\.dev$/.test(
      new URL(ctx.target).host,
    );

    for (const { header, title, fix, fixLink, blockerOnProduction } of headerChecks) {
      if (!home.headers[header]) {
        const severity: "blocker" | "warning" =
          blockerOnProduction && isProductionHost ? "blocker" : "warning";
        findings.push({ checkId: this.id, severity, title, location: header, fix, fixLink });
      }
    }

    // HTTPS enforcement: http:// must not serve the site.
    const httpRes = await cachedGet(ctx, ctx.target.replace(/^https:/, "http:"));
    if (httpRes.status === 200 && httpRes.url.startsWith("http:")) {
      findings.push({
        checkId: this.id,
        severity: "blocker",
        title: "Site serves content over plain HTTP",
        location: ctx.target.replace(/^https:/, "http:"),
        fix: "Force HTTPS: redirect all HTTP traffic (Vercel does this by default — check config).",
      });
    }
    return findings;
  },
};

export const headerChecksList: Check[] = [headersCheck];
