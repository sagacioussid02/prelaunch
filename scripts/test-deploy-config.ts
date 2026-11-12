/**
 * Free-plan deploy config checks.
 *
 * Vercel's Hobby plan rejects a deployment whose vercel.json has a cron
 * that runs more than once a day, so every cron here must be daily. The
 * hourly monitor trigger lives in .github/workflows/run-monitors.yml.
 *
 * Run: node scripts/test-deploy-config.ts
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

/** True when a 5-field cron expression fires at most once per day. */
export function atMostDaily(expr: string): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const single = (s: string) => /^\d+$/.test(s);
  return single(f[0]) && single(f[1]);
}

check("atMostDaily: daily", atMostDaily("30 4 * * *"));
check("atMostDaily: hourly is rejected", !atMostDaily("0 * * * *"));
check("atMostDaily: every 30 min is rejected", !atMostDaily("*/30 * * * *"));
check("atMostDaily: twice a day is rejected", !atMostDaily("0 6,18 * * *"));

const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
  fluid?: boolean;
  crons?: { path: string; schedule: string }[];
};
const crons = vercel.crons ?? [];
check("vercel.json: every cron runs at most daily (Hobby)", crons.every((c) => atMostDaily(c.schedule)), JSON.stringify(crons));
check("vercel.json: retention cron present", crons.some((c) => c.path === "/api/cron/retention"));
check("vercel.json: daily run-monitors fallback present", crons.some((c) => c.path === "/api/cron/run-monitors"));
check("vercel.json: Fluid compute on (300s maxDuration on Hobby)", vercel.fluid === true);

const wf = readFileSync(new URL("../.github/workflows/run-monitors.yml", import.meta.url), "utf8");
check("workflow: hourly schedule", /cron:\s*"\d+ \* \* \* \*"/.test(wf));
check("workflow: calls run-monitors", wf.includes("/api/cron/run-monitors"));
check("workflow: sends the CRON_SECRET bearer", wf.includes("secrets.CRON_SECRET") && wf.includes('Authorization: Bearer $CRON_SECRET'));
check("workflow: reads the URL from a repo variable", wf.includes("vars.PRELAUNCH_URL"));

// Scan functions launch a browser from files static tracing can't see.
const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
check("next.config: scan functions include the Chromium binary", nextConfig.includes("./node_modules/@sparticuz/chromium/bin/**"));
check("next.config: scan functions include all of playwright-core (browsers.json etc.)", nextConfig.includes("./node_modules/playwright-core/**"));
for (const route of ["/api/scan", "/api/monitor/*/deploy", "/api/cron/run-monitors"]) {
  check(`next.config: tracing includes cover ${route}`, nextConfig.includes(`"${route}": BROWSER_FILES`));
}
check("next.config: no literal [id] glob in tracing keys (it matches nothing)", !/"\/api\/monitor\/\[id\]\/deploy":/.test(nextConfig));

if (failures) {
  console.log(`${failures} FAILED (test-deploy-config)`);
  process.exit(1);
}
console.log("ALL PASS (test-deploy-config)");
