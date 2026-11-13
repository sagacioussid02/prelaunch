/**
 * Launch traffic forecast, milestone 2 self-test (lib/surge/pricing.ts,
 * lib/surge/model.ts, lib/checks/surge.ts).
 *
 * A. Pricing data: Hobby amounts and Pro rates as read on the as-of date.
 * B. Model (pure, no network): per-view costs from browser records, the
 *    plan's worked example, capacity, Pro cost after the usage credit,
 *    image transformations that don't grow with visitors, no-browser
 *    fallback.
 * C. Grading (pure): blocker only when a Hobby limit runs out on a Vercel
 *    site, warnings at half a limit / cookie pages / revalidating files,
 *    info for everything else, nothing at all for a healthy site.
 * D. End to end against a local fixture: a full passive scan registers the
 *    check, stores the forecast on the result, keeps to two GETs per route
 *    and grades the fixture's known problems.
 *
 * Usage: node scripts/test-surge-forecast.ts
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { ResponseRecord } from "../lib/checks/browser.ts";
import type { RouteProbe, SurgeMeasurement, ProbeSample } from "../lib/surge/measure.ts";
import { forecastInputs, project, usageFor, roughly, DEFAULT_VISITORS } from "../lib/surge/model.ts";
import type { ForecastInputs } from "../lib/surge/model.ts";
import { VERCEL_HOBBY, VERCEL_PRO, PRICING_AS_OF, RESOURCE_ORDER } from "../lib/surge/pricing.ts";
import { forecastFindings } from "../lib/checks/surge.ts";
import { registry } from "../lib/checks/index.ts";

process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// --- helpers --------------------------------------------------------------
const T = "https://site.test";
function rec(path: string, type: string, bytes: number, extra: Partial<ResponseRecord> = {}): ResponseRecord {
  return {
    url: T + path, status: 200, resourceType: type, sameOrigin: true, bytes, contentType: "",
    cacheControl: "", vercelCache: "", cdnCache: "", age: "", setsCookie: false, ...extra,
  };
}
function sample(p: Partial<ProbeSample> = {}): ProbeSample {
  return {
    status: 200, ttfbMs: 50, bodyBytes: 50_000, contentLength: 50_000, contentType: "text/html",
    cacheControl: "", vercelCache: "HIT", cdnCache: "", age: null, setsCookie: false, varyCookie: false, host: "vercel", ...p,
  };
}
function probe(path: string, verdict: RouteProbe["verdict"], extra: Partial<RouteProbe> = {}, s: Partial<ProbeSample> = {}): RouteProbe {
  return { url: T + path, first: sample(s), second: sample(s), verdict, reason: verdict === "cached" ? "served from cache (HIT)" : "MISS on both visits: a function runs on every visit", ...extra };
}
function measurement(routes: RouteProbe[], host: SurgeMeasurement["host"] = "vercel"): SurgeMeasurement {
  return { host, routes, requests: routes.length * 2, skipped: [], measuredAt: new Date().toISOString() };
}
/** The plan's worked example: a 2.7 MB page of 50 same-origin responses. */
function heavyPage(assetCache: string): ResponseRecord[] {
  const out = [rec("/", "document", 50_000)];
  for (let i = 0; i < 49; i++) out.push(rec(`/img/${i}.jpg`, "image", Math.round((2_700_000 - 50_000) / 49), { cacheControl: assetCache }));
  return out;
}

async function main() {
  // --- A. pricing data ---------------------------------------------------
  check("A1 pricing has an as-of date", /^\d{4}-\d{2}-\d{2}$/.test(PRICING_AS_OF));
  const h = VERCEL_HOBBY.resources;
  check(
    "A2 Hobby amounts as published",
    h.cdnRequests?.included === 1_000_000 && h.fastDataTransfer?.included === 100 && h.functionInvocations?.included === 1_000_000 &&
      h.activeCpu?.included === 4 && h.imageTransformations?.included === 5_000 && h.fastOriginTransfer?.included === 10,
  );
  check("A3 Hobby is a hard cap with no rates", VERCEL_HOBBY.hardCaps && RESOURCE_ORDER.every((r) => !h[r]?.rate));
  const p = VERCEL_PRO.resources;
  check("A4 Pro is $20 with a $20 usage credit", VERCEL_PRO.monthlyBaseUsd === 20 && VERCEL_PRO.usageCreditUsd === 20);
  check("A5 Pro CDN requests and transfer are flat rate (not metered)", !p.cdnRequests?.rate && !p.fastDataTransfer?.rate && !!p.cdnRequests?.note);
  check("A6 Pro function rate $0.60 per 1M", p.functionInvocations?.rate?.usd === 0.6 && p.functionInvocations.rate.per === 1_000_000);

  // --- B. model ------------------------------------------------------------
  {
    // Revalidating images: every later page asks for all 50 again.
    const inputs = forecastInputs({ target: T, measurement: measurement([probe("/", "cached"), probe("/about", "cached")]), responses: heavyPage("public, max-age=0, must-revalidate") });
    check("B1 first view counts every same-origin response", inputs.firstView.cdnRequests === 50, String(inputs.firstView.cdnRequests));
    check("B2 first view weight is the page's encoded bytes", near(inputs.firstView.transferBytes, 2_700_000, 1e-3), String(inputs.firstView.transferBytes));
    check("B3 later views re-request revalidating files", inputs.repeatView.cdnRequests === 50, String(inputs.repeatView.cdnRequests));
    check("B4 revalidating files are listed", inputs.revalidatingAssetCount === 49 && inputs.revalidatingAssets.length === 10);
    const g = project(inputs, VERCEL_HOBBY);
    const req = g.rows.find((r) => r.resource === "cdnRequests")!;
    check("B5 worked example: 10,000 visitors x 2 pages = 1M CDN requests (100% of Hobby)", req.usage === 1_000_000 && near(req.share!, 1));
    check("B6 capacity = cap / per-visitor usage", req.capacityVisitors === 10_000 && g.capacityVisitors === 10_000 && g.firstLimit === "cdnRequests");
    check("B7 cached pages run no functions", g.rows.find((r) => r.resource === "functionInvocations")!.usage === 0);
  }
  {
    // Same page, files cached for a year: later pages only fetch the HTML.
    const inputs = forecastInputs({ target: T, measurement: measurement([probe("/", "cached"), probe("/about", "cached")]), responses: heavyPage("public, max-age=31536000, immutable") });
    const g = project(inputs, VERCEL_HOBBY);
    const req = g.rows.find((r) => r.resource === "cdnRequests")!;
    check("B8 long-cached files: 51 requests per visitor, 51% of Hobby", req.usage === 510_000 && near(req.share!, 0.51), String(req.usage));
    const fdt = g.rows.find((r) => r.resource === "fastDataTransfer")!;
    check("B9 transfer in GB (2.7 MB + 50 KB per visitor)", near(fdt.usage, 27.5, 1e-3), fdt.usage.toFixed(3));
    check("B10 capacity is limited by requests at about 19,600 visitors", g.capacityVisitors === Math.floor(1_000_000 / 51), String(g.capacityVisitors));
    check("B11 usage is linear in visitors", near(usageFor(inputs, 20_000, 2).cdnRequests, 2 * usageFor(inputs, 10_000, 2).cdnRequests));
  }
  {
    // Uncached home + an uncached API call on every page.
    const responses = [
      rec("/", "document", 40_000),
      rec("/api/me", "fetch", 2_000, { vercelCache: "MISS" }),
      rec("/api/config", "fetch", 1_000, { vercelCache: "HIT" }),
      rec("/_next/image?url=%2Fa.png&w=640", "image", 10_000, { cacheControl: "public, max-age=31536000, immutable" }),
      rec("/_next/image?url=%2Fb.png&w=640", "image", 10_000, { cacheControl: "public, max-age=31536000, immutable" }),
      rec("/_next/image?url=%2Fa.png&w=640", "image", 10_000, { cacheControl: "public, max-age=31536000, immutable" }),
    ];
    const inputs = forecastInputs({ target: T, measurement: measurement([probe("/", "uncached"), probe("/blog", "uncached")]), responses });
    check("B12 invocations: uncached page + uncached API call (cached API call free)", inputs.firstView.invocations === 2 && inputs.repeatView.invocations === 2, JSON.stringify(inputs.firstView));
    check("B13 origin bytes: uncached HTML + uncached API body", inputs.firstView.originBytes === 42_000, String(inputs.firstView.originBytes));
    check("B14 later pages repeat API calls", inputs.repeatView.cdnRequests === 3, String(inputs.repeatView.cdnRequests));
    check("B15 distinct optimized images counted once", inputs.imageTransforms === 2);
    const a = usageFor(inputs, 10, 2).imageTransformations;
    const b = usageFor(inputs, 1_000_000, 2).imageTransformations;
    check("B16 image transformations don't grow with visitors", a === 2 && b === 2);
    const g = project(inputs, VERCEL_HOBBY);
    const cpu = g.rows.find((r) => r.resource === "activeCpu")!;
    const open = forecastInputs({ target: T, measurement: measurement([probe("/", "cached")]), responses: [rec("/", "document", 1000), rec("/api/slow", "fetch", 0, { status: 0 }), rec("/late.png", "image", 0, { status: 0 })] });
    check("B16b request still open at snapshot end: counted, not billed as a function", open.firstView.cdnRequests === 3 && open.firstView.invocations === 0 && open.repeatView.cdnRequests === 2, JSON.stringify(open));
    check("B17 Active CPU = invocations x 50 ms", near(cpu.usage, (40_000 * 50) / 3_600_000), cpu.usage.toFixed(4));
  }
  {
    // Pro: metered charges come out of the $20 credit first.
    const small: ForecastInputs = {
      host: "vercel", firstView: { cdnRequests: 10, transferBytes: 1e6, invocations: 1, originBytes: 0 },
      repeatView: { cdnRequests: 1, transferBytes: 5e4, invocations: 1, originBytes: 0 },
      imageTransforms: 0, cpuMsPerInvocation: 50, routes: [], revalidatingAssets: [], revalidatingAssetCount: 0, assumptions: [],
    };
    const pro = project(small, VERCEL_PRO, 10_000, 2);
    check("B18 small launch on Pro costs the base price", pro.estimatedMonthlyUsd === 20, String(pro.estimatedMonthlyUsd));
    check("B19 Pro has no capacity limit and flat-rate CDN shows no charge", pro.capacityVisitors === null && pro.rows.find((r) => r.resource === "cdnRequests")!.overageUsd === null);
    const big = { ...small, firstView: { ...small.firstView, invocations: 20 }, repeatView: { ...small.repeatView, invocations: 20 } };
    const p2 = project(big, VERCEL_PRO, 1_000_000, 2);
    // 40M invocations: $24 + 40M x 50ms = 555.6 h x $0.128 = $71.11 ; minus $20 credit, plus $20 base
    const expected = Math.round((20 + 40 * 0.6 + ((40e6 * 50) / 3.6e6) * 0.128 - 20) * 100) / 100;
    check("B20 big launch on Pro: base + metered - credit", near(p2.estimatedMonthlyUsd, expected, 1e-4), `${p2.estimatedMonthlyUsd} vs ${expected}`);
  }
  {
    const html = `<html><head><link rel="stylesheet" href="/a.css"><script src="/b.js"></script><script src="https://cdn.other/x.js"></script></head><body><img src="/c.png"></body></html>`;
    const inputs = forecastInputs({ target: T, measurement: measurement([probe("/", "cached")]), responses: null, noBrowserReason: "no Chromium", homeHtml: html });
    check("B21 no browser: forecast is partial with the reason", !!inputs.partial && inputs.partial.includes("no Chromium"));
    check("B22 no browser: requests = page + same-origin asset tags", inputs.firstView.cdnRequests === 4, String(inputs.firstView.cdnRequests));
  }
  check("B23 roughly() rounds for headlines", roughly(19_607) === "20,000" && roughly(1234) === "1,200" && roughly(2_500_000) === "2.5 million");

  // --- C. grading ----------------------------------------------------------
  const grade = (inputs: ForecastInputs) => forecastFindings(T, inputs, project(inputs, VERCEL_HOBBY));
  const sev = (fs: ReturnType<typeof grade>, s: string) => fs.filter((x) => x.severity === s);
  {
    const fs = grade(forecastInputs({ target: T, measurement: measurement([probe("/", "cached"), probe("/about", "cached")]), responses: heavyPage("public, max-age=0, must-revalidate") }));
    const blockers = sev(fs, "blocker");
    check("C1 Hobby limit runs out at the launch size → exactly one blocker", blockers.length === 1 && /CDN requests/.test(blockers[0].title), fs.map((x) => `${x.severity}:${x.title}`).join(" | "));
    check("C2 blocker says when the limit runs out", /about 10,000 visitors/.test(blockers[0].location), blockers[0].location);
    check("C3 49 revalidating files → warning with a headers() fix", sev(fs, "warning").some((x) => /re-checked/.test(x.title) && /headers\(\)/.test(x.fix)));
  }
  {
    const fs = grade(forecastInputs({ target: T, measurement: measurement([probe("/", "cached"), probe("/about", "cached")]), responses: heavyPage("public, max-age=31536000, immutable") }));
    check("C4 51% of a limit → warning, no blocker", sev(fs, "blocker").length === 0 && sev(fs, "warning").some((x) => /over half/.test(x.title) && /CDN requests: 51%/.test(x.location)), fs.map((x) => x.title).join(" | "));
  }
  {
    const inputs = forecastInputs({ target: T, measurement: measurement([probe("/", "cached"), probe("/about", "cached")], "netlify"), responses: heavyPage("public, max-age=0, must-revalidate") });
    const fs = grade(inputs);
    check("C5 not on Vercel: limit findings are info only", sev(fs, "blocker").length === 0 && fs.some((x) => x.severity === "info" && /Hobby's CDN requests limit/.test(x.title)));
    check("C6 not on Vercel: says Vercel Hobby is a yardstick", fs.some((x) => /Netlify, so Vercel Hobby is used as a yardstick/.test(x.title)));
    check("C7 not on Vercel: cache findings still warn", sev(fs, "warning").some((x) => /re-checked/.test(x.title)));
  }
  {
    const routes = [
      probe("/", "uncached", { cacheBreaker: "set-cookie" }),
      probe("/pricing", "uncached", { reason: "cache bypassed (BYPASS): a function runs on every visit" }),
      probe("/dashboard", "uncached", {}, { ttfbMs: 2400 }),
      probe("/about", "cached"),
    ];
    routes[2].second = sample({ ttfbMs: 300 });
    const fs = grade(forecastInputs({ target: T, measurement: measurement(routes), responses: [rec("/", "document", 20_000), rec("/logo.svg", "image", 900, { cacheControl: "public, max-age=0" })] }));
    const cookie = fs.find((x) => /skip the CDN cache/.test(x.title));
    check("C8 cookie and BYPASS pages → one warning naming both", cookie?.severity === "warning" && /\/, \/pricing/.test(cookie.location), cookie?.location);
    const plain = fs.find((x) => /runs a function on every visit/.test(x.title));
    check("C9 other uncached page → info", plain?.severity === "info" && /\/dashboard/.test(plain.location));
    check("C10 one revalidating file → info, not warning", fs.some((x) => x.severity === "info" && /1 static file is/.test(x.title)));
    check("C11 slow first response then fast → cold start info", fs.some((x) => x.severity === "info" && /cold start/.test(x.title) && x.location === "/dashboard"));
  }
  {
    const fs = grade(forecastInputs({ target: T, measurement: measurement([probe("/", "cached"), probe("/about", "cached")]), responses: [rec("/", "document", 30_000), rec("/_next/static/a.js", "script", 90_000, { cacheControl: "public, max-age=31536000, immutable" })] }));
    check("C12 healthy cached site → no findings (grade unchanged)", fs.length === 0, fs.map((x) => x.title).join(" | "));
  }
  {
    const fs = grade(forecastInputs({ target: T, measurement: measurement([probe("/", "cached")]), responses: null, noBrowserReason: "no Chromium", homeHtml: "<html></html>" }));
    check("C13 partial forecast → info that says why", fs.some((x) => x.severity === "info" && /partial/.test(x.title) && /no Chromium/.test(x.fix)));
  }
  {
    const imgs: ResponseRecord[] = [rec("/", "document", 1000)];
    for (let i = 0; i < 3000; i++) imgs.push(rec(`/_next/image?url=%2F${i}.png&w=640`, "image", 100, { cacheControl: "public, max-age=31536000, immutable" }));
    const fs = grade(forecastInputs({ target: T, measurement: measurement([probe("/", "cached")]), responses: imgs }));
    check("C14 one page using 60% of image transformations → warning", fs.some((x) => x.severity === "warning" && /60% of Vercel Hobby's monthly image transformations/.test(x.title)), fs.map((x) => x.title).join(" | "));
  }

  // --- D. end to end ---------------------------------------------------------
  check("D1 forecast check is registered for anonymous scans", registry.some((c) => c.id === "surge-forecast" && c.modes.includes("passive")));

  // Only the forecast's own probes: the scanner's User-Agent with the probe's Accept header
  // (the other checks in a full scan fetch these paths too).
  const hits = new Map<string, number>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    const ua = req.headers["user-agent"] ?? "";
    if (ua.startsWith("PreLaunchCheck/") && req.headers["accept"] === "text/html,*/*;q=0.8") hits.set(path, (hits.get(path) ?? 0) + 1);
    const html = (body: string, headers: Record<string, string>) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "x-vercel-id": "iad1::x", ...headers });
      res.end(`<html lang="en"><head><title>Fixture</title><meta name="viewport" content="width=device-width"></head><body><h1>Fixture</h1><p>Visible text for the browser checks.</p>${body}</body></html>`);
    };
    switch (path) {
      case "/":
        return html(
          `<a href="/about">About</a> <a href="/blog">Blog</a> <a href="/logout">Log out</a>
           <img src="/a.png" alt="a"><img src="/b.png" alt="b"><img src="/c.png" alt="c">
           <script>fetch("/api/me")</script>`,
          { "x-vercel-cache": "MISS", "set-cookie": "sid=1; Path=/", "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate" },
        );
      case "/about":
        return html("", { "x-vercel-cache": "PRERENDER" });
      case "/blog":
        return html("", { "x-vercel-cache": "MISS" });
      case "/a.png":
      case "/b.png":
      case "/c.png":
        res.writeHead(200, { "Content-Type": "image/png", "x-vercel-cache": "HIT", "cache-control": "public, max-age=0, must-revalidate" });
        return res.end(Buffer.alloc(2000, 1));
      case "/api/me":
        res.writeHead(200, { "Content-Type": "application/json", "x-vercel-cache": "MISS", "cache-control": "private, no-store" });
        return res.end('{"me":null}');
      default:
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const { runScan } = await import("../lib/scanner.ts");
    const result = await runScan(`http://127.0.0.1:${port}`, "passive", "surge-e2e");
    const prog = result.progress?.find((x) => x.id === "surge-forecast");
    check("D2 forecast check finished on the progress list", prog?.status === "done" && (prog.outcome === "issues" || prog.outcome === "passed"), JSON.stringify(prog));
    const fc = result.forecast;
    check("D3 forecast stored on the scan result", !!fc && fc.graded.plan === "hobby" && fc.graded.visitors === DEFAULT_VISITORS && fc.pro.plan === "pro");
    check("D4 host detected as Vercel", fc?.inputs.host === "vercel");
    const routes = fc?.inputs.routes.map((r) => `${r.path}:${r.verdict}`).join(",") ?? "";
    check("D5 verdicts: / uncached (cookie), /about cached, /blog uncached", routes === "/:uncached,/about:cached,/blog:uncached", routes);
    const counts = JSON.stringify(Object.fromEntries(hits));
    check("D6 forecast never fetched /logout", !hits.has("/logout"), counts);
    check("D7 forecast made exactly two GETs per route", hits.get("/") === 2 && hits.get("/about") === 2 && hits.get("/blog") === 2 && hits.size === 3, counts);
    check("D7b request count stored with the forecast", fc?.requests === 6, String(fc?.requests));
    const mine = result.findings.filter((x) => x.checkId === "surge-forecast");
    check("D8 cookie home page → warning", mine.some((x) => x.severity === "warning" && /skips the CDN cache because it sets a cookie/.test(x.title)), mine.map((x) => `${x.severity}:${x.title}`).join(" | "));
    check("D9 /blog → info", mine.some((x) => x.severity === "info" && /\/blog/.test(x.location)));
    if (fc?.inputs.partial) {
      console.log(`SKIP  D10-D11 browser records (forecast partial: ${fc.inputs.partial})`);
    } else {
      check("D10 browser: 3 revalidating images → warning", mine.some((x) => x.severity === "warning" && /3 static files are re-checked/.test(x.title)), mine.map((x) => x.title).join(" | "));
      // Under a full scan's load the page's fetch("/api/me") can still be open when the
      // snapshot ends; it is then recorded with status 0 and still counted as a request.
      // (How finished API calls count as function runs is covered by B12.)
      const v = fc?.inputs.firstView;
      check("D11 browser: page, 3 images and the /api/me call all counted", v?.cdnRequests === 5, JSON.stringify(v));
    }
    check("D12 no blocker for a small fixture site", !mine.some((x) => x.severity === "blocker"));
    const json = JSON.stringify(fc);
    check("D13 stored forecast stays small (< 8 KB)", json.length < 8_000, `${json.length} bytes`);
  } finally {
    server.close();
  }

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
