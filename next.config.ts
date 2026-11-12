import type { NextConfig } from "next";

// Files a scan function needs at runtime that static tracing can't see.
const BROWSER_FILES = [
  "./node_modules/@sparticuz/chromium/bin/**",
  "./node_modules/playwright-core/**",
];

const nextConfig: NextConfig = {
  // Domain is parameterized — attached only after Sidd's explicit go-ahead.
  // Prototype deploys to a private *.vercel.app with Deployment Protection on.
  // Playwright launches a native browser and must not be bundled.
  serverExternalPackages: ["playwright", "playwright-core", "@sparticuz/chromium"],
  // Issue #5: @sparticuz/chromium resolves its binary from the package's
  // bin/ files at runtime, which file tracing cannot follow statically —
  // include them explicitly in every function that can execute a scan
  // (direct scan POSTs, deploy-triggered monitor runs, the cron runner).
  //
  // Since 1.65, playwright-core ships as one bundle that loads browsers.json,
  // package.json, cli.js and files under lib/ through computed paths, which
  // tracing misses too ("Cannot find module …/playwright-core/browsers.json").
  // Include the whole package (about 14 MB) alongside the Chromium binary.
  outputFileTracingIncludes: {
    "/api/scan": BROWSER_FILES,
    // Keys are globs, so a literal "[id]" would be a character class and
    // match nothing; "*" matches the dynamic segment.
    "/api/monitor/*/deploy": BROWSER_FILES,
    "/api/cron/run-monitors": BROWSER_FILES,
  },
  // Issue #7: scan reports, monitor dashboards and API responses must never
  // be indexed — a report can describe someone else's site. The pages also
  // set robots metadata; this header covers the API routes and acts as a
  // second layer on the pages.
  async headers() {
    const noindex = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
    return [
      { source: "/api/:path*", headers: noindex },
      { source: "/r/:path*", headers: noindex },
      { source: "/m/:path*", headers: noindex },
    ];
  },
};

export default nextConfig;
