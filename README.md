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
lib/surge/measure.ts   launch traffic forecast, step 1: CDN/host detection and per-route cache inspection (≤2 sequential GETs per route)
lib/surge/pricing.ts   launch traffic forecast: Vercel Hobby limits and Pro rates as data, with source and as-of date
lib/surge/model.ts     launch traffic forecast: per-visitor cost, usage at V visitors, capacity and Pro cost (pure)
lib/checks/surge.ts    surge-forecast check: grades the forecast at 10,000 visitors on Hobby
lib/checks/meta.ts     plain-language "what it looks for / why it matters" copy
lib/monitor.ts         deploy monitoring: baseline diff, new-blocker alerts
lib/jobs.ts            background scan job with live per-check progress
lib/cikeys.ts          Prelaunch keys for the GitHub Action (hashed, tied to an email)
lib/github-oidc.ts     GitHub Actions OIDC token verification (free tier for public repos)
lib/ciauth.ts          CI scan auth: key → paid, public-repo OIDC → free, limits
action/                the GitHub Action (action.yml, index.mjs, lib.mjs)
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

## Launch traffic forecast

The `surge-forecast` check answers "what does launch day do to this site?".
It fetches the home page and up to five linked pages twice, one request at a
time and 2 s apart (never `/api`, auth, logout and the like), reads how the
CDN served each, and weighs a real page view from the desktop browser
snapshot. From that it works out what one visitor costs the host (CDN
requests, transfer, function runs, Active CPU, origin transfer, image
transformations) and projects it onto Vercel's plans (`lib/surge/pricing.ts`,
read 2026-11-12).

Grading always uses 10,000 visitors viewing 2 pages each, on Hobby, so scans
and monitor diffs stay comparable:

- **blocker**: a Hobby limit runs out at that size (Vercel sites only; Hobby
  can't buy more, so Vercel would limit the site for the rest of the month)
- **warning**: a limit passes 50%; a page skips the CDN because it sets or
  varies on cookies, or BYPASS; 3+ static files revalidate on every view;
  one page uses half the image transformations
- **info**: other uncached pages, cold starts, a partial forecast (no
  browser), and limit findings for sites not on Vercel

The whole forecast (per-visitor inputs, the Hobby projection and the same
launch on Pro) is stored as `forecast` on the scan result. It is an estimate
from a sample of pages: Active CPU per function run is assumed (50 ms), and
ISR, middleware and bot traffic aren't modelled. Pro costs use Vercel's
"starting at" rates after the $20 usage credit, so they are a floor.

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
is verified (claim/verify endpoints), `/api/cron/run-monitors` (Bearer
`CRON_SECRET`, fails closed when unset) re-audits on the monitor's cadence
(`intervalMinutes`, default daily). Unverified or disabled monitors are never
run on a schedule.

**Schedules on Vercel's free Hobby plan:** Hobby allows only daily crons, so
`vercel.json` runs `/api/cron/run-monitors` once a day (06:00 UTC, a
fallback) and `/api/cron/retention` once a day (04:30 UTC). The GitHub
Actions workflow `.github/workflows/run-monitors.yml` adds a run every 6
hours (00:17, 06:17, 12:17, 18:17 UTC). It needs the repo secret
`CRON_SECRET` (same value as on Vercel) and `PRELAUNCH_URL` (the production
URL, as a repo variable or secret); until both are set it skips with a
warning. Monitors with a shorter cadence (Pro's hourly) therefore run at most
every 6 hours. The endpoint only starts monitors that are due, so the
two triggers never double-run one; a monitor may run up to 30% of its
interval (at most 45 minutes) early, so a trigger that fires a little
earlier than the last one doesn't skip it. On the daily fallback alone, a
daily monitor can occasionally skip a day, because Hobby crons fire anywhere
in their hour. `vercel.json` also turns on Fluid
compute, which gives Hobby functions the 300s `maxDuration` the scan routes
use. GitHub pauses scheduled workflows after 60 days without repository
activity; re-enable it from the Actions tab if that happens.

**Plan limits:** when a monitor is created with an `email`, the owner is
on the Free plan (1 active monitor, passive scans, daily cadence minimum)
unless they hold Pro — Pro allows 10 monitors,
full-mode scans, and hourly cadence. Duplicates return 409; plan-cap and
full-mode-on-Free rejections return 402 with an upgrade hint, and a
cadence below the plan minimum is raised to it (noted in the response).
Limits gate creation only; runs, webhooks, and verification are never
plan-gated.

**Billing:** Pro is sold as a Stripe subscription (APIs only for now —
the landing-page upgrade UI is a later step). `POST /api/billing/checkout`
starts a hosted Checkout session for the Pro price (`STRIPE_PRICE_ID_PRO`,
suggested $9/mo), `POST /api/billing/portal` opens the Stripe Billing
Portal for the stored customer, `GET /api/billing/status?email=` reports
the resolved plan, and `POST /api/billing/webhook` (signature-verified,
fail-closed) syncs subscription state into the store. Plan resolution
reads the stored subscription first — active/trialing/past_due is Pro —
and falls back to the `PRO_EMAILS` list for manual grants. With no
Stripe keys set, billing is off (checkout/portal 503) and nothing
changes for Free users.

## GitHub Action

`action/` is a GitHub Action that scans a PR's preview deployment and
comments the result on the PR (usage: [action/README.md](action/README.md)).
It calls `POST /api/ci/scan`, then polls the same `GET /api/scan/{id}` and
`GET /api/report/{id}?format=json` endpoints the website uses.

- **Free tier, public repositories:** the Action sends a GitHub Actions
  OIDC token (audience `prelaunch`). `lib/github-oidc.ts` verifies it
  against GitHub's published keys and reads `repository_visibility`, which
  the workflow can't forge. Private or internal → 402.
- **Paid tier, any repository:** `Authorization: Bearer plk_…`. Keys
  (`lib/cikeys.ts`) are stored as SHA-256 hashes and belong to an email;
  the key scans only while that email resolves to Pro through billing, so
  a lapsed subscription turns it off without revoking it. Issue, list and
  revoke them with `node scripts/ci-key.ts issue <email> [label]`
  (`DATABASE_URL` set to write to production).
- **Limits (`lib/ciauth.ts`, `app/api/ci/scan/route.ts`):** 20 CI scans an
  hour per public repository, 60 per key (`PRELAUNCH_CI_SCANS_PER_HOUR_FREE`
  / `_PAID`), keyed on the credential instead of the IP because hosted
  runners share IPs. The per-host and global caps and the SSRF guard apply
  to CI scans unchanged, and `/api/scan` keeps its own limits. CI scans are
  passive on both tiers.

## Run the tests

```bash
node scripts/test-scan.ts        # fixture scan (expects F/0) + passive example.com scan
node scripts/test-ssrf.ts        # SSRF guard: blocked ranges, IPv4-mapped IPv6, redirect-to-private hop
node scripts/test-browser.ts     # browser (#5): serverless launch, partial-grade banner, in-browser SSRF block
node scripts/test-notifications.ts  # regression email: decision matrix, dedupe, delivery records
node scripts/test-monitor-runner.ts # scheduled runner: due-selection + live fixture run
node scripts/test-monitor-claim.ts  # domain verification: claim/publish/verify + tamper cases
node scripts/test-deploy-hooks.ts   # deploy token accept/reject + cron-secret fail-closed
node scripts/test-plans.ts       # plan limits: gate, counting, route 402/409/201
node scripts/test-billing.ts     # billing: status matrix, event routing, store, plan resolution
node scripts/test-billing-routes.ts # billing routes: checkout/portal/webhook via a stubbed Stripe
node scripts/test-background-jobs.ts # scan deadline + stale expiry, 10-scan run, monitor running flag always clears
node scripts/test-deploy-config.ts   # vercel.json crons are daily (Hobby), Fluid on, 6-hourly GitHub Actions trigger
node scripts/test-retention.ts      # 30-day scan retention keeps monitor history; cron auth (add PRELAUNCH_TEST_DATABASE_URL for the Postgres cases)
node scripts/test-abuse-controls.ts # cross-instance 429, per-host + global caps, manual-run 401, hashed-IP request log
node scripts/test-surge-measure.ts  # launch traffic forecast M1: cache verdicts, ≤2 sequential GETs/route, unsafe links skipped, SSRF, real page weight
node scripts/test-surge-forecast.ts # launch traffic forecast M2: pricing data, model maths, severities, full scan stores the forecast
node scripts/test-check-outcomes.ts # each check shows passed / issues / failed / didn't run with the reason; partial scans aren't "ready to launch"
node scripts/test-ci-auth.ts     # GitHub Action server side: keys, OIDC verification, tiers, /api/ci/scan limits
node scripts/test-ci-action.ts   # GitHub Action: target/summary helpers, full runs against stub Prelaunch + GitHub APIs
node scripts/scan-once.ts <url>  # one-off scan, writes report.html
```

Zero dependencies — runs on stock Node 22.18+ (type-stripping; no build step).
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

## License

MIT — see [LICENSE](LICENSE).
