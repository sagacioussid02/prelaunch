/**
 * Extension stand-in for lib/checks/index.ts (swapped in by build.mjs).
 *
 * Only the passive checks that need nothing but HTTP GETs are registered.
 * They are the exact check modules the website, the GitHub Action, the API
 * and the Apify Actor run, imported unchanged. Left out: the browser
 * simulations and the launch-traffic forecast (they need headless
 * Chromium), and the owner-only checks (bundle secrets, Supabase key, open
 * APIs, preview protection), which Prelaunch runs only behind ownership
 * proof.
 */
import type { Check } from "../../../lib/checks/types.ts";
import { secretChecks } from "../../../lib/checks/secrets.ts";
import { headerChecksList } from "../../../lib/checks/headers.ts";
import { seoChecks } from "../../../lib/checks/seo.ts";
import { errorChecks } from "../../../lib/checks/errors.ts";

export const registry: Check[] = [...secretChecks, ...headerChecksList, ...seoChecks, ...errorChecks].filter((c) =>
  c.modes.includes("passive"),
);
