# Prelaunch for Chrome

A Manifest V3 extension that runs Prelaunch's launch-readiness checks on
the site in the open tab, from the user's own browser.

## How it works

- `src/engine.ts` runs Prelaunch's own checks from `lib/checks` through
  `runOne()` and `grade()` from `lib/scanner.ts`, so a finding reads the
  same as on the website, the API and the Apify Actor.
- `build.mjs` bundles it with esbuild and swaps three server-only modules
  for browser stand-ins (`src/shims`):
  - `lib/checks/index.ts` → a registry with only the fetch-only passive
    checks (the browser simulations and the traffic forecast need headless
    Chromium; the owner-only checks stay owner-only);
  - `lib/checks/browser.ts` → no-op stubs;
  - `lib/ssrf.ts` → a guard that allows only the host being scanned, so a
    page can't make the extension fetch another host (a router on the LAN,
    a CDN). Source maps for scripts served from another host are therefore
    not checked by the extension.
- Requests to the scanned host follow redirects and send the user's
  cookies. That's what lets it check `localhost`, a Vercel preview behind
  Vercel Authentication, or a staging site behind a login. Results stay in
  the browser (cached for 10 minutes in `chrome.storage.session`).
- `src/background.ts` (service worker) asks ExtensionPay whether the user
  has paid and picks the tier; the popup never decides that.
- Permissions: `activeTab` and `storage` at install. Access to a site
  (`https://host/*` and `http://host/*`, so the HTTPS check can probe
  plain HTTP) is asked the first time the user presses Scan on it.

| Tier | Checks | Shows |
| --- | --- | --- |
| Free (quick) | exposed `.env`, sourcemap exposure, security headers | grade, score, counts, which checks found something |
| Paid (full) | the three above plus SEO basics, custom 404, error verboseness | every finding with location, fix and docs link; Markdown and JSON export |

## Build and try it

```bash
cd extension
npm install
npm run build          # release build into extension/dist
```

Open `chrome://extensions`, turn on Developer mode, press **Load
unpacked** and pick `extension/dist`. Open any site and click the
Prelaunch icon.

Until the ExtensionPay id in `src/config.ts` is registered at
extensionpay.com, the unlock button opens ExtensionPay's page for an
unknown extension and everyone stays on the free tier.

## Test

```bash
cd extension && npm install
node ../scripts/test-chrome-extension.ts
```

Builds the release and test variants, runs the built service worker in a
Node vm against local fixture sites (fake Chrome APIs, fake ExtPay driven
by `chrome.storage.local`), and drives the built popup in jsdom. It does
not launch a real Chrome; do the "Load unpacked" check above before
publishing.

`npm run build:test` builds the test variant (fake ExtPay, every site
pre-allowed); never upload that one. The test script leaves a release
build in `dist` when it finishes.

## Publish (owner steps)

1. **ExtensionPay:** sign up at extensionpay.com, register the extension,
   connect Stripe, and create the plan (see the pricing proposal in
   `docs/chrome-web-store-listing.md`). Put the extension id in
   `src/config.ts` if it isn't `prelaunch-check`.
2. Test a payment in ExtensionPay's test mode with a loaded unpacked build.
3. `npm run package` → `extension/prelaunch-chrome-<version>.zip`.
4. **Chrome Web Store:** register a developer account (one-time fee),
   upload the zip, and fill the listing, privacy and permission fields from
   `docs/chrome-web-store-listing.md`. Screenshots: 1280×800 of the popup
   on a real site (free and paid).
5. Submit for review.

ExtPay.js (LGPL-3.0) ships unmodified as its own file, `dist/ExtPay.js`.
