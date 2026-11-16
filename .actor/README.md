# Prelaunch: Launch-Readiness Scan

Find the things that should block a launch before your users (or attackers) do. Give this Actor one or more public website URLs and get back a grade, a launch-ready yes/no, and every finding with a one-line fix.

It runs the same checks as [Prelaunch](https://github.com/sagacioussid02/prelaunch), built for Vercel and Next.js apps but useful on any public site.

## What it checks

**Quick scan** (seconds, no browser):

- **Exposed environment files:** `/.env`, `/.env.local`, `/.env.production` readable by anyone.
- **Public source maps:** `.map` files that ship your original source code.
- **Security headers:** Content-Security-Policy, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, and plain-HTTP serving.

**Full scan** (usually under a minute, real headless browser): everything in the quick scan, plus

- error-page verbosity and a custom 404 page
- SEO basics (title, description, Open Graph, canonical)
- page load, mobile layout, accessibility, performance and broken-link checks in a real browser
- read-only user-journey checks
- a launch-traffic forecast for your hosting
- desktop, tablet and mobile screenshots

Every check is passive: read-only requests, no logins, no form submissions, nothing that changes the site. Private, local and internal addresses are refused.

## How much it costs

You pay per finished scan, nothing else:

| Event | Price |
| --- | --- |
| `quick-scan` | $0.02 per site |
| `full-scan` | $0.08 per site |

URLs that are invalid, private or don't respond are reported in the results and **not charged**. Set a maximum cost on the run and the Actor stops starting new scans once the next one wouldn't fit.

## Input

```json
{
  "urls": ["https://your-app.vercel.app", "https://staging.example.com"],
  "scanType": "quick"
}
```

| Field | What it does |
| --- | --- |
| `urls` | Sites to scan, up to 100 per run. Duplicates are scanned once. |
| `scanType` | `quick` (default) or `full`. |
| `includeScreenshots` | Full scans: save screenshots to the run's key-value store (default on). |
| `maxConcurrency` | Sites scanned at once: up to 10 for quick (default 5), up to 2 for full (default 1). |

## Output

One dataset item per URL:

```json
{
  "inputUrl": "your-app.vercel.app",
  "url": "https://your-app.vercel.app",
  "scanType": "quick",
  "status": "done",
  "grade": "C",
  "score": 75,
  "ready": false,
  "blockers": 1,
  "warnings": 2,
  "info": 0,
  "checks": [
    { "id": "exposed-env", "name": "Exposed .env files", "outcome": "issues", "findings": 1 }
  ],
  "findings": [
    {
      "checkId": "exposed-env",
      "severity": "blocker",
      "title": "/.env is publicly reachable and looks like an env file",
      "location": "https://your-app.vercel.app/.env",
      "fix": "Block dotfiles at the edge (Vercel rewrites/headers) and rotate every key inside."
    }
  ],
  "checkedAt": "2026-11-16T05:00:00.000Z",
  "durationMs": 2140
}
```

- `ready` is `true` only when there are no blockers and every check ran.
- `grade` runs A+ to F: the score starts at 100 and loses 15 per blocker, 5 per warning and 1 per info finding.
- A URL that couldn't be scanned gets `"status": "error"` and an `error` message instead.
- The run's `OUTPUT` record sums it up: how many were scanned, ready, not ready, errored or skipped.

## Use it from CI or an AI agent

Run it synchronously and fail the build when a site isn't ready:

```bash
curl -s -X POST \
  "https://api.apify.com/v2/acts/<username>~prelaunch-launch-check/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://your-app.vercel.app"]}' \
  | jq -e 'all(.[]; .ready)'
```

AI agents can call it through the [Apify MCP server](https://mcp.apify.com) like any other Actor: give it a URL and read back `ready`, `blockers` and `findings`.

## Limits and notes

- Up to 100 URLs per run. Only public `http` and `https` sites.
- A scan looks at the site's homepage and well-known paths; it doesn't crawl or log in.
- Sites behind Vercel Deployment Protection or a login wall answer with a sign-in page, so most checks can't see the real app.
- Full scans need a browser, so give the run at least 2 GB of memory (the default).
