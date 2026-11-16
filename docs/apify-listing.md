# Prelaunch on the Apify Store: pricing and publishing

The Actor lives in `.actor/` (definition, input and dataset schemas, Dockerfile, Store README) and `apify/` (entry code and its own `package.json`). It bundles the same `lib/` scan code the website, the GitHub Action and the RapidAPI endpoint use, so findings read the same everywhere.

Prices are approved (2026-11-16). Published on the Store as https://apify.com/whispery_artemisia/prelaunchapi.

## What it sells

| Scan | What runs | Typical time |
| --- | --- | --- |
| Quick | `lib/quickcheck.ts`: exposed `.env`, public source maps, security headers | 1 to 5 s per site |
| Full | `runScan(url, "passive")`: every anonymous Prelaunch check, including the headless-browser simulations, SEO basics and the launch-traffic forecast, plus screenshots | 5 to 60 s per site |

Both refuse private, local and unresolvable hosts (`lib/ssrf.ts`), and both report an invalid or unreachable URL as an error item without charging for it.

## Pricing (pay per event, approved 2026-11-16)

| Event name | Title | Price | Per 1,000 |
| --- | --- | --- | --- |
| `quick-scan` (primary) | Quick scan | $0.02 | $20 |
| `full-scan` | Full scan | $0.08 | $80 |

Also in the Console's "Actor pricing" step:

- **Remove `apify-default-dataset-item`.** Apify adds it by default and charges per dataset item. Error items (bad or unreachable URLs) would then cost the user money, which the listing promises not to do.
- **Keep `apify-actor-start` at its default.** It's tiny ($0.05 per 1,000 starts per GB of memory) and covers the first seconds of compute.
- **Leave "Pay per event + usage" off,** so the user sees one price per scan.

Why these numbers:

- **Revenue share:** Apify pays 80% of event revenue; profit = 0.8 × revenue − platform usage. Free-plan users' usage is covered by Apify.
- **Quick:** $0.02 leaves $0.016 per scan before compute. The RapidAPI endpoint runs the same three checks at $9 for 1,000 calls ($0.01 overage), and Apify's Store users also pay for a hosted run, batch input and storage, so twice the RapidAPI overage is a fair middle.
- **Full:** a real browser, 13 checks, screenshots and the traffic forecast. $0.08 leaves $0.064 before compute, which stays comfortably positive even for a 60-second run at 2 GB.
- **Compute is the unknown.** Platform cost per scan depends on the memory the user picks (default 2 GB) and how slow the target site is. After the first test runs on Apify, check each run's usage cost in Console against these prices before publishing.

## Code-side billing rules (already built)

- One `Actor.charge()` per finished scan, after its result is saved.
- A scan starts only while the run's maximum cost still covers it, counting scans already in flight, so a run never overspends. URLs left over are listed in the run's `OUTPUT` and not charged.
- Up to 100 URLs per run; quick scans 5 at a time (max 10), full scans 1 at a time (max 2).

## Publishing steps (Sidd)

1. ~~Merge the PR.~~ Done (PR #43).
2. Create or sign in to an Apify account, and set up payouts in Console if you haven't.
3. In Apify Console, create a new Actor from this GitHub repository on the `main` branch. Apify reads `.actor/` at the repo root, and the Docker build context is the repo root.
4. Build it, then run it on one of your own sites with both scan types and check the results and the run cost.
5. Under Publication, set pay-per-event pricing as above, then publish to the Store. The Store page uses `.actor/README.md`.
6. ~~Add the Apify link to the main README, the Action README, the Prelaunch site and the report.~~ Done.

## Running it locally

```bash
cd apify
npm ci
npm run build
npm test      # node ../scripts/test-apify-actor.ts
```

`npm test` covers input parsing, billing (one charge per scan, nothing for errors, stopping at the spending limit), both scans against local fixtures, the definition files, and an end-to-end run of the built Actor with simulated pay-per-event pricing.

To try the real image with Chromium: `docker build -f .actor/Dockerfile -t prelaunch-actor .` from the repo root.

`pg` and `@vercel/blob` are in `apify/package.json` only because `lib/store.ts` imports them. The Actor never uses them: `apify/src/env.ts` clears their environment variables so screenshots go to local disk, then to the run's key-value store.
