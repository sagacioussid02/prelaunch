/** Plain-language copy shown in the UI: what each check looks for and why it matters. */

export interface CheckMeta {
  /** What we look for */
  looksFor: string;
  /** Why a failure matters */
  why: string;
}

export const CHECK_META: Record<string, CheckMeta> = {
  "client-bundle-secrets": {
    looksFor: "Downloads your JavaScript bundles and hunts for API keys, tokens and passwords that anyone can read.",
    why: "Anything in client JS is public. A leaked secret key lets attackers run up your bills or read your data.",
  },
  "exposed-env": {
    looksFor: "Requests common paths like /.env and /.git/config to see if config files are publicly reachable.",
    why: "An exposed .env file hands over every credential your app uses.",
  },
  "sourcemap-leak": {
    looksFor: "Checks whether source maps are published next to your bundles.",
    why: "Source maps reveal your original source code, comments and internal routes.",
  },
  "supabase-anon-exposed": {
    looksFor: "Finds Supabase keys in the page and checks they are the safe 'anon' kind, not 'service-role'.",
    why: "A service-role key bypasses all row-level security and exposes the whole database.",
  },
  "unprotected-api": {
    looksFor: "Calls common API paths without credentials to see which ones answer with data.",
    why: "Open API routes let strangers read or change data without logging in.",
  },
  "preview-protection": {
    looksFor: "Checks whether this deployment looks like an unprotected Vercel preview.",
    why: "Unprotected previews leak unreleased work and are indexed by search engines.",
  },
  "security-headers": {
    looksFor: "Reads response headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy and HTTPS redirect.",
    why: "These headers block clickjacking, script injection and downgrade attacks with almost no effort.",
  },
  "seo-basics": {
    looksFor: "Looks for title, meta description, Open Graph tags, robots.txt, sitemap.xml and favicon.",
    why: "Without them your launch link previews badly and search engines index you poorly.",
  },
  "custom-404": {
    looksFor: "Requests a page that cannot exist and checks that you return a real, branded 404.",
    why: "Soft-404s hurt SEO and a default error page looks unfinished.",
  },
  "error-verbosity": {
    looksFor: "Sends a malformed request and checks the error does not leak stack traces or file paths.",
    why: "Verbose errors show attackers your framework, file layout and sometimes database details.",
  },
  "sim-load": {
    looksFor: "Opens your site in a real Chrome browser and watches for console errors, crashes, failed requests and blank screens.",
    why: "These are the things your visitors hit first, and they never show up in a header scan.",
  },
  "sim-mobile": {
    looksFor: "Renders your page as a phone and a tablet, then checks for sideways scrolling, missing viewport tag, tiny text and tiny tap targets.",
    why: "More than half of visitors are on mobile; a broken layout loses them immediately.",
  },
  "sim-a11y": {
    looksFor: "Inspects the live DOM for images without alt text, unlabeled inputs and buttons, missing page language and heading structure.",
    why: "Accessibility gaps exclude users, invite legal risk, and usually signal sloppy markup.",
  },
  "sim-perf": {
    looksFor: "Measures real load time, largest contentful paint, layout shift, request count and total download size.",
    why: "Slow, janky pages lose visitors and rank lower in search.",
  },
  "sim-links": {
    looksFor: "Follows a sample of the links on your page and reports any that are broken or redirect forever.",
    why: "Dead links on launch day look careless and break user journeys.",
  },
  "sim-journeys": {
    looksFor: "Generates user journeys from your page: visits key pages, fills forms with test data (never submits) and, in owner mode, clicks safe buttons.",
    why: "Catches pages that crash or forms that accept anything, the way real users will find them.",
  },
};

export function metaFor(id: string): CheckMeta {
  return (
    CHECK_META[id] ?? {
      looksFor: "Runs an automated check against your site.",
      why: "Reported issues can affect security, quality or reach.",
    }
  );
}
