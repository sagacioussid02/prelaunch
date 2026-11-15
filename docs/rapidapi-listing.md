# RapidAPI listing draft: Prelaunch Launch Check

Draft for review. Nothing here is live: no RapidAPI account, listing or
price exists yet. Numbers marked "suggested" are proposals to decide on.

## Listing basics

- **Name:** Prelaunch Launch Check
- **Category:** Security (secondary: Monitoring / DevTools)
- **Short description (≤ 100 chars):**
  Check any URL for leaked .env files, public sourcemaps and missing security headers.
- **Base URL:** the production Prelaunch URL. Endpoint: `POST /api/v1/check`.
- **Spec:** import [rapidapi-openapi.yaml](rapidapi-openapi.yaml) (set `servers` first).
- **Gateway timeout:** 30 s is plenty (each check is capped at 15 s; most
  calls finish in 1 to 5 s). RapidAPI's maximum is 180 s.

## Long description

One call tells you whether a site is about to ship one of three mistakes
that teams roll back releases for:

1. **Exposed .env files.** `/.env`, `/.env.local` and `/.env.production`
   publicly readable with real-looking variables. Blocker: rotate every key.
2. **Public sourcemaps.** Script bundles whose `.map` file ships the
   original source (`sourcesContent`).
3. **Security headers and HTTPS.** Missing Content-Security-Policy, HSTS,
   X-Frame-Options, X-Content-Type-Options, Referrer-Policy or
   Permissions-Policy, and pages served over plain HTTP.

You get back a letter grade, a 0 to 100 score, a `ready` flag (no blockers
and every check ran) and each finding with where it was found and a
one-line fix. Built for CI steps, deploy pipelines and AI agents that need a
yes/no before a URL goes live.

Read-only: a handful of GET requests to public pages, nothing submitted,
nothing stored. Private, local and cloud-metadata addresses are refused.

## Endpoint docs

`POST /api/v1/check`

Request:

```json
{ "url": "https://example.com" }
```

Response `200` (abridged):

```json
{
  "url": "https://example.com",
  "grade": "F",
  "score": 45,
  "ready": false,
  "summary": { "blockers": 3, "warnings": 2, "info": 0 },
  "checks": [
    { "id": "exposed-env", "name": "Exposed .env files", "outcome": "issues", "findings": 1 },
    { "id": "sourcemap-leak", "name": "Sourcemap exposure", "outcome": "passed", "findings": 0 },
    { "id": "security-headers", "name": "Security headers", "outcome": "issues", "findings": 4 }
  ],
  "findings": [
    {
      "checkId": "exposed-env",
      "severity": "blocker",
      "title": "/.env is publicly reachable and looks like an env file",
      "location": "https://example.com/.env",
      "fix": "Block dotfiles at the edge (Vercel rewrites/headers) and rotate every key inside."
    },
    {
      "checkId": "security-headers",
      "severity": "warning",
      "title": "Missing Content-Security-Policy",
      "location": "content-security-policy",
      "fix": "Add a CSP header (start with report-only) via next.config.js headers.",
      "fixLink": "https://nextjs.org/docs/app/guides/content-security-policy"
    }
  ],
  "checkedAt": "2026-11-15T00:24:22.536Z",
  "durationMs": 1840
}
```

Grading: start at 100, minus 15 per blocker, 5 per warning, 1 per info.
A+ 95+, A 90+, B 80+, C 70+, D 60+, F below.

Errors are JSON `{ "error": "...", "status": 400 }`:

| Status | When |
| --- | --- |
| 400 | Missing or invalid `url`, or a private/local/unresolvable host |
| 422 | The site didn't respond |
| 429 | Rate limited; see `Retry-After`. Includes "one site checked more than 10 times in an hour" |
| 500 | The check couldn't complete; retry |

Example (curl):

```bash
curl -X POST https://prelaunch-launch-check.p.rapidapi.com/api/v1/check \
  -H "Content-Type: application/json" \
  -H "X-RapidAPI-Key: YOUR_KEY" \
  -H "X-RapidAPI-Host: prelaunch-launch-check.p.rapidapi.com" \
  -d '{"url":"https://example.com"}'
```

(The host name is assigned by RapidAPI when the listing is created.)

## Suggested pricing tiers

RapidAPI keeps a flat 25% of each payment, so "you keep" is 75%.

| Plan | Suggested price | Checks / month | Over quota | You keep |
| --- | --- | --- | --- | --- |
| Basic | Free | 50 | Hard limit | $0 |
| Pro | $9 / month | 1,000 | $0.01 each | $6.75 |
| Ultra | $29 / month | 5,000 | $0.008 each | $21.75 |
| Mega | $99 / month | 25,000 | $0.005 each | $74.25 |

Why these numbers: the free tier lets an agent or CI integration be tried
for real before paying; Pro at $9 matches the $9/month suggested for Prelaunch Pro (.env.example);
each call costs only a few outbound GETs on Vercel, so even Mega's per-check
price is far above cost. Free alternatives (securityheaders.com, Mozilla
Observatory) cover headers only, so the .env and sourcemap checks plus a
single JSON answer are the selling point.

Server-side safety caps (in code, per RapidAPI user per hour) sit above
these quotas so paying users never hit them: Basic 20, Pro 120, Ultra 400,
Mega 1,000. One limit customers can hit: any single site can be checked at
most 10 times an hour across all callers, to protect third-party sites.
Worth stating in the listing's terms.

## To go live (each needs Sidd's yes)

1. Merge the PR and let it deploy to production.
2. Create a RapidAPI provider account and the API, using the spec above.
3. Copy the X-RapidAPI-Proxy-Secret from the Provider Dashboard's Security
   tab into the Vercel production env var `RAPIDAPI_PROXY_SECRET`, then
   redeploy. Until then the endpoint answers 503 to everything.
4. Set the plans and prices, connect a payout method, publish the listing.
5. Optional hardening: allowlist RapidAPI's gateway IPs in the Vercel
   firewall (RapidAPI publishes the list; all regions must be allowed).
