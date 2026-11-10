import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Domain is parameterized — attached only after Sidd's explicit go-ahead.
  // Prototype deploys to a private *.vercel.app with Deployment Protection on.
  // Playwright launches a native browser and must not be bundled.
  serverExternalPackages: ["playwright", "playwright-core", "@sparticuz/chromium"],
  // Issue #5: @sparticuz/chromium resolves its binary from the package's
  // bin/ files at runtime, which file tracing cannot follow statically —
  // include them explicitly in every function that can execute a scan
  // (direct scan POSTs, deploy-triggered monitor runs, the cron runner).
  outputFileTracingIncludes: {
    "/api/scan": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/monitor/[id]/deploy": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/cron/run-monitors": ["./node_modules/@sparticuz/chromium/bin/**"],
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
