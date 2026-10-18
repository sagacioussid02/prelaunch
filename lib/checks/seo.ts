/**
 * SEO / launch basics (category weight: 10). Passive.
 * All info/warning — never blockers. These exist because "launch-ready"
 * means more than security, and they pad the report nicely.
 */

import type { Check, Finding, ScanContext } from "./types.ts";
import { cachedGet, extractMetas } from "./types.ts";

const CATEGORY = "SEO & launch basics";
const WEIGHT = 10;

const seoCheck: Check = {
  id: "seo-basics",
  name: "SEO & launch basics",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const home = await cachedGet(ctx, ctx.target + "/");
    if (home.status === 0 || !home.body) return findings;

    const info = (title: string, fix: string): Finding => ({
      checkId: this.id,
      severity: "info",
      title,
      location: ctx.target + "/",
      fix,
    });

    const title = home.body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
    if (!title) {
      findings.push(
        info("Missing <title>", "Add a <title> in app/layout.tsx metadata (aim for <60 chars)."),
      );
    }

    const metas = extractMetas(home.body);
    if (!metas["description"]) {
      findings.push(
        info(
          "Missing meta description",
          "Add metadata.description — it becomes the search-result snippet.",
        ),
      );
    }
    if (!metas["og:title"] && !metas["og:image"]) {
      findings.push(
        info(
          "No Open Graph tags",
          "Add og:title/og:image so link shares render a preview card.",
        ),
      );
    }
    if (!/<link[^>]+rel=["']icon["']/i.test(home.body)) {
      findings.push(info("No favicon declared", "Add app/icon.png — browsers request it anyway."));
    }

    const robots = await cachedGet(ctx, ctx.target + "/robots.txt");
    if (robots.status !== 200) {
      findings.push(
        info("No robots.txt", "Add app/robots.ts — even a permissive one stops 404 noise."),
      );
    } else if (/Disallow:\s*\//i.test(robots.body) && !/Disallow:\s*$/.test(robots.body)) {
      findings.push({
        checkId: this.id,
        severity: "warning",
        title: "robots.txt disallows all crawling",
        location: ctx.target + "/robots.txt",
        fix: "Remove 'Disallow: /' before launch or search engines will ignore you.",
      });
    }

    const sitemap = await cachedGet(ctx, ctx.target + "/sitemap.xml");
    if (sitemap.status !== 200) {
      findings.push(
        info("No sitemap.xml", "Add app/sitemap.ts for faster indexing of new pages."),
      );
    }

    return findings;
  },
};

const notFoundCheck: Check = {
  id: "custom-404",
  name: "Custom 404 page",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const res = await cachedGet(
      ctx,
      ctx.target + "/this-page-should-not-exist-" + Date.now().toString(36),
    );
    if (res.status !== 404) {
      return [
        {
          checkId: this.id,
          severity: "warning",
          title: `Bogus path returns ${res.status} instead of 404`,
          location: res.url,
          fix: "Add app/not-found.tsx so dead links show your brand, not a blank page.",
        },
      ];
    }
    if (/this-page-should-not-exist/i.test(res.body)) {
      return [
        {
          checkId: this.id,
          severity: "info",
          title: "Default 404 page detected",
          location: res.url,
          fix: "Ship a custom 404 (app/not-found.tsx) with navigation back into the app.",
        },
      ];
    }
    return [];
  },
};

export const seoChecks: Check[] = [seoCheck, notFoundCheck];
