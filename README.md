# PreLaunch Check — prototype

One-click pre-launch audit for Vercel/Next.js apps: paste a URL, get a graded,
shareable report page. This is the **prototype** (goal step 3 of 5) — a working
scan engine + report renderer, tested against a deliberately vulnerable local
fixture.

## Layout

```
lib/checks/types.ts    Check/Finding types, fetch cache, HTML helpers, entropy
lib/checks/secrets.ts  client-bundle-secrets (FULL), exposed-env, sourcemap-leak
lib/checks/auth.ts     supabase-anon-exposed, unprotected-api, preview-protection (FULL)
lib/checks/headers.ts  security headers + HTTPS enforcement (passive-safe)
lib/checks/seo.ts      title/meta/OG/robots/sitemap/favicon/404 (passive-safe)
lib/checks/errors.ts   error-verboseness probes (passive-safe)
lib/checks/simulations.ts  live Chromium simulations: load, mobile/tablet, a11y, perf, links, generated journeys
lib/checks/browser.ts  shared Playwright session (SSRF-guarded, read-only journeys)
lib/checks/meta.ts     plain-language "what it looks for / why it matters" copy
lib/monitor.ts         deploy monitoring: baseline diff, new-blocker alerts
lib/jobs.ts            background scan job with live per-check progress
lib/checks/index.ts    central registry — new checks plug in here
lib/scanner.ts         parallel runner (per-check timeout), grading
lib/report.ts          shareable report HTML + SVG badge renderer
lib/store.ts           storage: Neon Postgres + Vercel Blob when env is set, JSON files otherwise
lib/db.ts              Postgres pool/schema for scans + monitors (issue #3)
app/                   Next.js routes: landing, /r/[id] report, /api/scan, /api/badge
scripts/test-scan.ts   self-test: vulnerable local fixture + passive real-world check
scripts/scan-once.ts   CLI: node scripts/scan-once.ts <url> [--full] [--out report.html]
hidden/                test outputs (sample report)
```

## Scan modes (revised stance, 2026-10-16)

- `passive` (default, anonymous): read-only single GETs — headers, SEO,
  `.env`/sourcemap reachability, error verbosity. Safe for any URL.
- `full` (ownership proof required): bundle secret pattern-matching,
  Supabase key review, API probing. Prototype gates it behind
  `x-prelaunch-owner-token` == `PRELAUNCH_OWNER_TOKEN`; v2 replaces this
  with the Vercel deploy-hook ownership flow.

## Live simulations

Needs Chromium: `npx playwright install chromium` (falls back to an installed
Google Chrome; skipped with an info finding if neither exists). Pages are
rendered at desktop/tablet/phone sizes, journeys are generated from the page's
real links and forms. Forms are filled but never submitted, non-GET requests
are blocked, and button clicking only runs in `full` mode.

## Deploy monitoring

On a report page, "Enable monitoring" returns a deploy-hook URL
(`/api/monitor/{id}/deploy?token=…`, shown once) plus a dashboard at `/m/{id}`.
Point a Vercel "Deployment Ready" webhook or a CI step at the hook. The first
audit is the baseline; later audits record and alert (optional Slack/Discord
webhook) only on blockers that were not in the previous run. Alerts are
rate-limited to one audit per monitor per minute.

Monitoring v2 adds two channels on top. **Email:** create a monitor with an
`email` and regressions — new blockers, or a score drop of 10+ points vs the
previous run — are emailed via Resend (`RESEND_API_KEY` + `NOTIFY_FROM`;
without them the alert is recorded as "queued" and nothing is sent). Each
incident emails once: the regression set is hashed, repeats are deduped, and
a healthy run re-arms the alert. **Scheduled runs:** once a monitor's domain
is verified (claim/verify endpoints), the hourly Vercel Cron hits
`/api/cron/run-monitors` (Bearer `CRON_SECRET`, fails closed when unset) and
re-audits on the monitor's cadence (`intervalMinutes`, default daily).
Unverified or disabled monitors are never run on a schedule.

## Run the tests

```bash
node scripts/test-scan.ts        # fixture scan (expects F/0) + passive example.com scan
node scripts/test-notifications.ts  # regression email: decision matrix, dedupe, delivery records
node scripts/test-monitor-runner.ts # scheduled runner: due-selection + live fixture run
node scripts/test-monitor-claim.ts  # domain verification: claim/publish/verify + tamper cases
node scripts/test-deploy-hooks.ts   # deploy token accept/reject + cron-secret fail-closed
node scripts/scan-once.ts <url>  # one-off scan, writes report.html
```

Zero dependencies — runs on stock Node 20+ (type-stripping; no build step).
`npm install` is only needed for the Next.js app (`npm run dev`).

## Deploy checklist (next steps, not this run)

1. `npm install && npm run build`, deploy to a **private** `*.vercel.app`
   with Deployment Protection on — domain stays parameterized.
2. ~~Swap `lib/store.ts` for Postgres (Neon)~~ — done (issue #3): set
   `DATABASE_URL` for scans/monitors and `BLOB_READ_WRITE_TOKEN` for
   screenshots; unset means the JSON file store. Still to do: upgrade
   the in-memory `/api/scan` rate limit (5 scans/hour/IP) + concurrency
   cap to Upstash Ratelimit (Redis-backed) for multi-instance production.
3. Dogfood: `--full` scans of Sidd's own Vercel projects.
4. Domain (`prelaunchcheck.dev` recommended) attached only after his go-ahead.
