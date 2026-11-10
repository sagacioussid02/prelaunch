import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Domain is parameterized — attached only after Sidd's explicit go-ahead.
  // Prototype deploys to a private *.vercel.app with Deployment Protection on.
  // Playwright launches a native browser and must not be bundled.
  serverExternalPackages: ["playwright", "playwright-core"],
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
