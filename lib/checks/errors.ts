/**
 * Error-handling checks (category weight: 5). Passive.
 * Trigger a 404 and a bogus API route; flag stack traces, framework
 * version strings, or verbose error bodies.
 */

import type { Check, Finding, ScanContext } from "./types.ts";
import { cachedGet } from "./types.ts";

const CATEGORY = "Error handling";
const WEIGHT = 5;

/** Strings that should never appear in a production response body. */
const LEAK_PATTERNS: Array<{ re: RegExp; title: string; fix: string }> = [
  {
    re: /at\s+\w+\s*\(.*node_modules.*\)|Error:[\s\S]{0,80}at\s+Object\./,
    title: "Stack trace exposed in response",
    fix: "Disable verbose errors in production (Next.js hides these by default — check NODE_ENV).",
  },
  {
    re: /next[./-]server\s*v?(\d+\.\d+\.\d+)/i,
    title: "Next.js version string exposed",
    fix: "Strip framework version headers/bodies; keep Next.js patched.",
  },
  {
    re: /"digest"\s*:\s*"[0-9]+"/,
    title: "Next.js error digest in client response",
    fix: "Use a custom error.tsx boundary that returns a generic message.",
  },
];

const errorVerbosity: Check = {
  id: "error-verbosity",
  name: "Error verboseness",
  category: CATEGORY,
  categoryWeight: WEIGHT,
  modes: ["passive", "full"],
  async run(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const probes = [
      ctx.target + "/api/does-not-exist-" + Date.now().toString(36),
      ctx.target + "/this-page-should-not-exist",
    ];
    for (const url of probes) {
      const res = await cachedGet(ctx, url);
      if (res.status === 0 || !res.body) continue;
      for (const { re, title, fix } of LEAK_PATTERNS) {
        if (re.test(res.body)) {
          findings.push({
            checkId: this.id,
            severity: "warning",
            title,
            location: res.url,
            fix,
          });
          break;
        }
      }
    }
    return findings;
  },
};

export const errorChecks: Check[] = [errorVerbosity];
