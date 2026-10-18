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
lib/checks/index.ts    central registry — new checks plug in here
lib/scanner.ts         parallel runner (per-check timeout), grading
lib/report.ts          shareable report HTML + SVG badge renderer
lib/store.ts           JSON file store (prototype) — swap for Neon at deploy
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

## Run the tests

```bash
node scripts/test-scan.ts        # fixture scan (expects F/0) + passive example.com scan
node scripts/scan-once.ts <url>  # one-off scan, writes report.html
```

Zero dependencies — runs on stock Node 20+ (type-stripping; no build step).
`npm install` is only needed for the Next.js app (`npm run dev`).

## Deploy checklist (next steps, not this run)

1. `npm install && npm run build`, deploy to a **private** `*.vercel.app`
   with Deployment Protection on — domain stays parameterized.
2. Swap `lib/store.ts` for Postgres (Neon); add Upstash Ratelimit
   (5 scans/hour/IP) in front of `/api/scan`.
3. Dogfood: `--full` scans of Sidd's own Vercel projects.
4. Domain (`prelaunchcheck.dev` recommended) attached only after his go-ahead.
