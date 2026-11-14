# Prelaunch Check GitHub Action

Scans each pull request's preview deployment for launch problems and
reports them on the PR before merge: exposed `.env` files and source maps,
missing security headers, SEO gaps, verbose errors, broken pages and the
launch-day traffic forecast. Scans are passive (read-only GETs), the same
checks as an anonymous scan on prelaunch-check.vercel.app.

On each run it:

- scans the URL (a Vercel preview, or one you pass),
- writes the grade and findings to the job summary,
- posts one comment on the PR and updates it on later runs,
- fails the check when it finds blockers (configurable).

## Free for public repositories

Public repositories need no key. The action asks GitHub for a short-lived
OIDC token, which proves to Prelaunch that the repository is public.

```yaml
# .github/workflows/prelaunch.yml
name: Prelaunch
on: deployment_status

permissions:
  id-token: write        # proves the repository is public (free tier)
  pull-requests: write   # the PR comment
  contents: read

jobs:
  scan:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: sagacioussid02/prelaunch/action@main
```

Vercel's GitHub integration creates a deployment for every push to a PR;
when it succeeds, this workflow scans its preview URL.

## Private repositories: Prelaunch key

Private and internal repositories need a Prelaunch key, which comes with
Prelaunch Pro. Add it as the repository secret `PRELAUNCH_API_KEY`:

```yaml
      - uses: sagacioussid02/prelaunch/action@main
        with:
          api-key: ${{ secrets.PRELAUNCH_API_KEY }}
```

`id-token: write` isn't needed with a key.

## Scanning a URL you choose

```yaml
on: pull_request
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions: { id-token: write, pull-requests: write }
    steps:
      - uses: sagacioussid02/prelaunch/action@main
        with:
          url: https://staging.example.com
          fail-on: warning
```

## Inputs

| Input | Default | |
| --- | --- | --- |
| `url` | deployment URL | What to scan. Empty on `deployment_status` uses the deployment's URL. |
| `api-key` | | Prelaunch key. Required for private repositories. |
| `fail-on` | `blocker` | `blocker`, `warning` (blockers or warnings) or `never`. With `never`, errors become warnings too. |
| `comment` | `true` | Post or update the PR comment. |
| `github-token` | `github.token` | Used to find the PR and write the comment. |
| `timeout-minutes` | `6` | How long to wait for the scan (1 to 30). |
| `prelaunch-url` | `https://prelaunch-check.vercel.app` | Prelaunch server. |

## Outputs

`grade`, `score`, `blockers`, `warnings`, `report-url`, `scan-id`.

## Limits

- Free tier: 20 scans an hour per repository. Paid: 60 an hour per key.
- Any one site can be scanned at most 10 times an hour across all
  Prelaunch users, so a busy PR queue against a single staging URL can hit
  that; Vercel previews have a URL per deployment and rarely do.
- Vercel turns on Deployment Protection for previews by default, and a
  protected preview only shows the scanner a login page. The action spots
  this and stops with an error rather than grade the login page. Turn
  protection off for previews, or scan a URL that is public.
