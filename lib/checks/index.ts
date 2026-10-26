/** Central check registry. New checks plug in here — the runner needs no changes. */
import type { Check } from "./types.ts";
import { secretChecks } from "./secrets.ts";
import { authChecks } from "./auth.ts";
import { headerChecksList } from "./headers.ts";
import { seoChecks } from "./seo.ts";
import { errorChecks } from "./errors.ts";
import { simulationChecks } from "./simulations.ts";

export const registry: Check[] = [
  ...secretChecks,
  ...authChecks,
  ...headerChecksList,
  ...seoChecks,
  ...errorChecks,
  ...simulationChecks,
];
