# Prelaunch for Chrome: Web Store listing, pricing proposal, publishing

Draft copy for the Chrome Web Store dashboard. The extension's code is in
`extension/` (see `extension/README.md`). Nothing here is live: pricing is
a proposal for Sidd, and the ExtensionPay account, the Web Store developer
account and publishing are Sidd's steps.

## Pricing proposal (not live)

| Plan | Price | Why |
| --- | --- | --- |
| Free | $0 | Quick check on any tab: grade, score and counts for exposed `.env`, public source maps and security headers. Shows the problem exists. |
| **Pro, one-time (proposed)** | **$15** | Full report: every finding, where it is, the fix and a docs link; three more checks; Markdown and JSON export. |

Why one-time: people use a launch checker around launches, not every
day, so a monthly charge is likely to churn after the first launch. A
one-time price is an easy yes next to the hosted options ($9/month on
RapidAPI, per scan on Apify). ExtensionPay supports `once`, monthly and
yearly plans, so a $4/month or $29/year plan can be added later if repeat
use shows up. ExtensionPay takes its cut per charge and Stripe its card fee
on top; check both sites for current rates before setting the price.

What the paid tier is worth versus the free website: the website's
passive scan is free, but it can't reach `localhost`, Vercel previews
behind Vercel Authentication, or a staging site behind a login, and it is
limited to 5 scans an hour. The extension does those from the user's own
browser, instantly and without limits. The listing leads with that.

## Store listing

**Name (max 75):** Prelaunch: launch-readiness check

**Summary (max 132):** Check your site before you launch: exposed .env files, leaked source maps, missing security headers. Works on localhost and previews.

**Category:** Developer Tools

**Language:** English

**Description:**

> Ship without the embarrassing launch-day bugs. Prelaunch checks the site in your open tab for the things that should block a release, and tells you how to fix each one.
>
> Free quick check:
> • Exposed .env files (/.env, /.env.local, /.env.production)
> • Source maps that publish your original code
> • Missing security headers (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy) and plain-HTTP serving
> You get a grade from A+ to F, a score out of 100, and the number of blockers and warnings.
>
> Full report (one-time unlock):
> • Every finding, where it was found, and the fix, with a docs link
> • Three more checks: SEO and launch basics (title, description, Open Graph, favicon, robots.txt, sitemap), custom 404 page, and error pages that leak stack traces or framework versions
> • Copy the report as Markdown for a pull request, or download it as JSON
>
> Works where hosted scanners can't: localhost, Vercel preview deployments behind Vercel Authentication, and staging sites you're signed in to. The checks run in your browser, on the site you choose, and nothing is sent to Prelaunch.
>
> Same checks and grading as prelaunch-check.vercel.app, the Prelaunch GitHub Action and API, so results line up everywhere.

**Website:** https://prelaunch-check.vercel.app

**Support URL / email:** the address on the privacy page (public on the listing).

**Screenshots (1280×800, 1 to 5):** popup on a real site with the free result and the unlock panel; popup with the full report; the Markdown export pasted into a GitHub PR. Take them from a "Load unpacked" release build.

**Small promo tile (440×280):** the icon on the brand indigo with "Launch-readiness check for your open tab".

## Privacy practices tab

**Single purpose:** Check the website in the user's open tab for launch-readiness problems (exposed secrets files, source maps, security headers, SEO basics, error handling) and report them.

**Permission justifications:**

- `activeTab`: to read the address of the tab the user is on when they open the popup, so the extension knows which site to check.
- `storage`: to keep the last result for 10 minutes so reopening the popup shows it, and for ExtensionPay to remember the user's purchase.
- Optional host permissions (`https://*/*`, `http://*/*`): requested for one site at a time, only when the user presses Scan, so the extension can fetch that site's pages and headers (both schemes, so it can tell whether the site also answers over plain HTTP). Never requested at install.

**Remote code:** No. All code ships in the package; ExtPay.js is bundled.

**Data usage (what to tick):**

- Website content: the extension reads pages from the site the user chooses to scan, in the browser, to check them. It isn't collected or transmitted.
- Personally identifiable information / payment: only for paid users, handled by ExtensionPay and Stripe at checkout (email, payment details).
- Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used for creditworthiness or lending.

**Privacy policy URL:** https://prelaunch-check.vercel.app/privacy (this branch adds a "Chrome extension" section; it needs to be merged and deployed before submitting).

## Publishing steps (Sidd)

1. Merge this branch and deploy, so the privacy page has the extension section.
2. Create the ExtensionPay account, register the extension with id `prelaunch-check` (or change `extension/src/config.ts`), connect Stripe, and create the plan you pick.
3. Load `extension/dist` unpacked in Chrome, run a scan on a real site and on a Vercel preview, and make a test-mode payment.
4. `cd extension && npm run package` and upload the zip.
5. Register the Chrome Web Store developer account (one-time fee), fill in this listing, and submit for review.
