import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Domain is parameterized — attached only after Sidd's explicit go-ahead.
  // Prototype deploys to a private *.vercel.app with Deployment Protection on.
  // Playwright launches a native browser and must not be bundled.
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default nextConfig;
