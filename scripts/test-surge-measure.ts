/**
 * Launch traffic forecast, milestone 1 self-test (lib/surge/measure.ts and
 * the browser snapshot's per-response records).
 *
 * A. Pure helpers: host detection, route verdicts, asset cache policy,
 *    route picking (never logout/api/cross-origin).
 * B. Cache inspection against a fixture that sends known cache headers:
 *    verdict per route, at most two GETs per route, never two requests in
 *    flight at once, the repeat visit waits the gap, unsafe links are never
 *    fetched, the time budget stops new requests.
 * C. SSRF: a route that redirects to the metadata address is refused.
 * D. Browser snapshot (when a browser launches): per-response records
 *    carry cache headers, and page weight counts a gzip response that
 *    has no content-length (the old transferKB undercount).
 *
 * Usage: node scripts/test-surge-measure.ts
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  assetCachePolicy,
  detectHost,
  getSurgeMeasurement,
  measureSurge,
  pickRoutes,
  probeOnce,
  routeVerdict,
  type ProbeSample,
} from "../lib/surge/measure.ts";
import { closeSession, getSession } from "../lib/checks/browser.ts";
import type { ScanContext } from "../lib/checks/types.ts";

// Fixture binds 127.0.0.1; loopback is permitted for self-tests only.
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// --- fixture -------------------------------------------------------------
const hits = new Map<string, number[]>(); // path -> request start times
let inFlight = 0;
let maxInFlight = 0;
let slowMs = 0;

// Random text so gzip can't shrink it to nothing: ~150 KB on the wire.
const BIG_JS = "/* " + randomBytes(150_000).toString("base64") + " */";
const BIG_JS_GZ = gzipSync(BIG_JS);

function handler(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "/").split("?")[0];
  const list = hits.get(path) ?? [];
  list.push(Date.now());
  hits.set(path, list);
  const n = list.length;
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  res.on("finish", () => inFlight--);

  const html = (body: string, headers: Record<string, string>) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
    res.end(`<html lang="en"><head><title>t</title></head><body><h1>Fixture</h1><p>Visible text here.</p>${body}</body></html>`);
  };

  switch (path) {
    case "/":
      // Vercel-style ISR: MISS on the first visit, HIT afterwards.
      return html(
        `<a href="/about">About</a> <a href="/dashboard">Dash</a> <a href="/pricing">Pricing</a>
         <a href="/logout">Log out</a> <a href="/api/data">API</a> <a href="/brochure.pdf">PDF</a>
         <a href="http://169.254.169.254/latest/meta-data">meta</a> <a href="https://example.com/x">ext</a>
         <a href="/about#team">About again</a> <a href="/cf">CF</a> <a href="/slow">Slow</a>
         <img src="/logo.png" alt="logo"><script src="/app.js"></script>`,
        { "x-vercel-id": "iad1::abc", "x-vercel-cache": n === 1 ? "MISS" : "HIT", "cache-control": "public, max-age=0, must-revalidate" },
      );
    case "/about":
      return html("", { "x-vercel-id": "iad1::abc", "x-vercel-cache": "PRERENDER" });
    case "/dashboard":
      // Function on every visit, and a cookie that defeats shared caching.
      return html("", { "x-vercel-id": "iad1::abc", "x-vercel-cache": "MISS", "set-cookie": "sid=abc; Path=/; HttpOnly", "cache-control": "private, no-cache" });
    case "/pricing":
      // No Vercel header: origin asks for shared caching; Age grows.
      return html("", { "cache-control": "public, s-maxage=600", age: String(n === 1 ? 0 : 3) });
    case "/cf":
      return html("", { "cf-ray": "123-IAD", "cf-cache-status": "DYNAMIC" });
    case "/slow":
      setTimeout(() => html("", { "x-vercel-cache": "MISS" }), slowMs);
      return;
    case "/redirect-meta":
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      return res.end();
    case "/logo.png":
      res.writeHead(200, { "Content-Type": "image/png", "cache-control": "public, max-age=0, must-revalidate" });
      return res.end(Buffer.alloc(5000, 1));
    case "/app.js":
      // gzip + chunked transfer: two writes, so Node sends no content-length.
      res.writeHead(200, { "Content-Type": "application/javascript", "Content-Encoding": "gzip", "cache-control": "public, max-age=31536000, immutable" });
      res.write(BIG_JS_GZ.subarray(0, 1000));
      return res.end(BIG_JS_GZ.subarray(1000));
    default:
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("nope");
  }
}

function sample(p: Partial<ProbeSample>): ProbeSample {
  return {
    status: 200, ttfbMs: 10, bodyBytes: 100, contentLength: null, contentType: "text/html",
    cacheControl: "", vercelCache: "", cdnCache: "", age: null, setsCookie: false, varyCookie: false, host: "unknown",
    ...p,
  };
}

async function main() {
  // --- A. pure helpers ---------------------------------------------------
  check("A1 vercel detected", detectHost({ "x-vercel-id": "x" }) === "vercel");
  check("A2 netlify detected", detectHost({ "x-nf-request-id": "x" }) === "netlify");
  check("A3 cloudflare detected", detectHost({ "cf-ray": "x" }) === "cloudflare");
  check("A4 unknown host", detectHost({ server: "nginx" }) === "unknown");
  check("A5 MISS then HIT is cached", routeVerdict(sample({ vercelCache: "MISS" }), sample({ vercelCache: "HIT" })).verdict === "cached");
  check("A6 MISS twice is uncached", routeVerdict(sample({ vercelCache: "MISS" }), sample({ vercelCache: "MISS" })).verdict === "uncached");
  check("A7 single MISS is unknown", routeVerdict(sample({ vercelCache: "MISS" })).verdict === "unknown");
  check("A8 BYPASS is uncached", routeVerdict(sample({ vercelCache: "BYPASS" }), sample({ vercelCache: "BYPASS" })).verdict === "uncached");
  check("A9 cloudflare DYNAMIC is uncached", routeVerdict(sample({ cdnCache: "DYNAMIC" }), sample({ cdnCache: "DYNAMIC" })).verdict === "uncached");
  check("A10 s-maxage is cached", routeVerdict(sample({ cacheControl: "public, s-maxage=60" }), sample({ cacheControl: "public, s-maxage=60" })).verdict === "cached");
  check("A11 no-store is uncached", routeVerdict(sample({ cacheControl: "no-store" })).verdict === "uncached");
  check("A12 404 is unknown", routeVerdict(sample({ status: 404 })).verdict === "unknown");
  check("A13 no signal is unknown", routeVerdict(sample({}), sample({})).verdict === "unknown");
  check("A14 immutable is long", assetCachePolicy("public, max-age=31536000, immutable") === "long");
  check("A15 max-age=0 revalidates", assetCachePolicy("public, max-age=0, must-revalidate") === "revalidates");
  check("A16 one hour is short", assetCachePolicy("public, max-age=3600") === "short");
  check("A17 missing header is none", assetCachePolicy("") === "none");
  const picked = pickRoutes("https://a.test", [
    "https://a.test/about", "https://a.test/about/", "https://a.test/logout", "https://a.test/api/x",
    "https://a.test/auth/callback", "https://a.test/authors", "https://b.test/x", "https://a.test/f.pdf",
    "https://a.test/sign-out", "https://a.test/unsubscribe?id=1", "https://a.test/blog",
  ]);
  check(
    "A18 routes: home first, unsafe/cross-origin/assets skipped, deduped",
    JSON.stringify(picked) === JSON.stringify(["https://a.test/", "https://a.test/about", "https://a.test/authors", "https://a.test/blog"]),
    JSON.stringify(picked),
  );
  check("A19 at most 6 routes", pickRoutes("https://a.test", Array.from({ length: 20 }, (_, i) => `https://a.test/p${i}`)).length === 6);

  // --- B. cache inspection against the fixture --------------------------
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const target = `http://127.0.0.1:${port}`;
  console.log(`fixture server on ${target}`);

  const homeHtml = await (await fetch(target + "/")).text();
  hits.clear(); // the probe above warmed "/"; reset so the MISS->HIT sequence is the measurement's own
  maxInFlight = 0;
  const { linksFromHtml } = await import("../lib/surge/measure.ts");
  const routes = pickRoutes(target, linksFromHtml(homeHtml, target));
  const gapMs = 300;
  const m = await measureSurge({ routes, gapMs });
  const by = Object.fromEntries(m.routes.map((r) => [new URL(r.url).pathname, r]));
  check("B1 host is vercel", m.host === "vercel", m.host);
  check("B2 probed home + 5 routes", m.routes.length === 6, m.routes.map((r) => new URL(r.url).pathname).join(","));
  check("B3 home MISS then HIT is cached", by["/"]?.verdict === "cached", by["/"]?.reason);
  check("B4 prerendered page cached", by["/about"]?.verdict === "cached", by["/about"]?.reason);
  check("B5 dashboard uncached + set-cookie breaker", by["/dashboard"]?.verdict === "uncached" && by["/dashboard"]?.cacheBreaker === "set-cookie", `${by["/dashboard"]?.verdict} ${by["/dashboard"]?.cacheBreaker}`);
  check("B6 s-maxage page cached via headers", by["/pricing"]?.verdict === "cached", by["/pricing"]?.reason);
  check("B7 cloudflare DYNAMIC uncached", by["/cf"]?.verdict === "uncached", by["/cf"]?.reason);
  check("B8 at most two GETs per route", [...hits.values()].every((t) => t.length <= 2), JSON.stringify([...hits].map(([k, v]) => [k, v.length])));
  check("B9 requests counted = 2 x routes", m.requests === 12, String(m.requests));
  check("B10 never two requests in flight", maxInFlight === 1, String(maxInFlight));
  check("B11 logout, api and pdf never fetched", !hits.has("/logout") && !hits.has("/api/data") && !hits.has("/brochure.pdf"));
  const homeHits = hits.get("/") ?? [];
  check("B12 repeat visit waits the gap", homeHits.length === 2 && homeHits[1] - homeHits[0] >= gapMs - 20, `${homeHits[1] - homeHits[0]}ms`);
  check("B13 TTFB and size recorded", (by["/"]?.first.ttfbMs ?? -1) >= 0 && (by["/"]?.first.bodyBytes ?? 0) > 100);

  // Time budget: a slow route uses it up, the rest is skipped, no repeat visits.
  hits.clear();
  slowMs = 700;
  const b = await measureSurge({ routes: [target + "/slow", target + "/about", target + "/pricing"], gapMs: 10, budgetMs: 300 });
  check("B14 budget stops new requests", b.skipped.length === 2 && b.requests === 1, `skipped=${b.skipped.length} requests=${b.requests}`);
  check("B15 budget-cut route is unknown, not uncached", b.routes[0]?.verdict === "unknown", b.routes[0]?.reason);
  slowMs = 0;

  // Memo: one measurement per scan.
  hits.clear();
  const ctx: ScanContext = { target, mode: "passive", cache: new Map(), scanId: "surge-test", screenshots: [] };
  const [m1, m2] = await Promise.all([getSurgeMeasurement(ctx), getSurgeMeasurement(ctx)]);
  check("B16 measurement memoized per scan", m1 === m2 && (hits.get("/about")?.length ?? 0) === 2);

  // --- C. SSRF -------------------------------------------------------------
  const red = await probeOnce(target + "/redirect-meta");
  check("C1 redirect to metadata refused", red.status === 0 && /SSRF|blocked/i.test(red.error ?? ""), red.error);
  const meta = await probeOnce("http://169.254.169.254/latest/meta-data");
  check("C2 metadata address refused", meta.status === 0 && !!meta.error, meta.error);

  // --- D. browser snapshot records ------------------------------------------
  if (!process.env.PRELAUNCH_CHROMIUM_PATH && existsSync("/opt/meta-chromium/chrome")) {
    process.env.PRELAUNCH_CHROMIUM_PATH = "/opt/meta-chromium/chrome";
  }
  const bctx: ScanContext = { target, mode: "passive", cache: new Map(), scanId: "surge-browser", screenshots: [] };
  const session = await getSession(bctx);
  if (!session) {
    console.log("SKIP  D browser snapshot — no browser could start here");
  } else {
    const snap = await session.snapshot("desktop");
    const js = snap.responses.find((r) => r.url.endsWith("/app.js"));
    const logo = snap.responses.find((r) => r.url.endsWith("/logo.png"));
    const doc = snap.responses.find((r) => r.resourceType === "document");
    check("D1 records include document, script, image", !!doc && !!js && !!logo, snap.responses.map((r) => r.resourceType).join(","));
    const raw = await fetch(target + "/app.js");
    check("D2a fixture script really has no content-length", !raw.headers.has("content-length"));
    await raw.arrayBuffer();
    check(
      "D2 gzip script without content-length is sized at its encoded size",
      (js?.bytes ?? 0) >= BIG_JS_GZ.length * 0.95 && (js?.bytes ?? 0) <= BIG_JS_GZ.length * 1.05,
      `bytes=${js?.bytes} gz=${BIG_JS_GZ.length}`,
    );
    check("D3 page weight counts it (old code counted 0 for it)", snap.transferKB >= Math.floor((BIG_JS_GZ.length + 5000) / 1024), `transferKB=${snap.transferKB}`);
    check("D4 asset cache headers captured", assetCachePolicy(js?.cacheControl ?? "") === "long" && assetCachePolicy(logo?.cacheControl ?? "") === "revalidates");
    check("D5 vercel cache header captured on document", ["MISS", "HIT"].includes(doc?.vercelCache ?? ""), doc?.vercelCache);
    check("D6 same-origin flag set", !!js?.sameOrigin && !!doc?.sameOrigin);
    await closeSession(bctx);
  }

  server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
