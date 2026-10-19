/**
 * Prototype self-test.
 *
 * Spins up a local HTTP server simulating an intentionally insecure
 * Next.js-ish app, then runs the scanner against it in FULL mode and
 * asserts the signature checks fire. Also runs a PASSIVE scan against
 * https://example.com as a real-world sanity check.
 *
 * Usage: node scripts/test-scan.ts
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { runScan } from "../lib/scanner.ts";
import { renderReport } from "../lib/report.ts";

// The fixture server binds 127.0.0.1, which the SSRF guard blocks by
// default. Permit loopback for this self-test only (metadata/link-local/
// private ranges stay blocked). Never set this in a deployed environment.
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";

// Fake key, assembled at runtime so the sk_live_ literal never appears in
// source — otherwise GitHub secret scanning blocks the push. Not a real key.
const FAKE_STRIPE_KEY = "sk_" + "live_" + "FIXTURE1234567890AB";
const FAKE_CHUNK = `
// Intentionally vulnerable fixture: a live Stripe secret baked into client JS.
var config = { stripeKey: "${FAKE_STRIPE_KEY}" };
var NEXT_PUBLIC_SUPABASE_URL = "https://xyz.supabase.co";
`;
const FAKE_MAP = JSON.stringify({
  version: 3,
  sources: ["webpack://app/page.tsx"],
  sourcesContent: ["export default function Page() { /* secret sauce */ }"],
  mappings: "AAAA",
});
const FAKE_ENV = "DATABASE_URL=postgres://user:pass@db:5432/app\nSTRIPE_SECRET=sk_live_xxx\n";

function handler(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? "/";
  const text = (code: number, body: string, type = "text/html") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };
  if (url === "/") {
    // Deliberately minimal: no security headers, no meta tags.
    text(
      200,
      `<html><head></head><body><h1>Vulnerable demo app</h1>` +
        `<script src="/_next/static/chunks/app-page-abc123.js"></script></body></html>`,
    );
  } else if (url === "/_next/static/chunks/app-page-abc123.js") {
    text(200, FAKE_CHUNK, "application/javascript");
  } else if (url === "/_next/static/chunks/app-page-abc123.js.map") {
    text(200, FAKE_MAP, "application/json");
  } else if (url === "/.env" || url === "/.env.local") {
    text(200, FAKE_ENV, "text/plain");
  } else if (url === "/api/users") {
    text(200, JSON.stringify([{ email: "admin@example.com", role: "admin" }]), "application/json");
  } else if (url === "/robots.txt") {
    text(200, "User-agent: *\nDisallow: /\n", "text/plain");
  } else if (url === "/api/bogus" || (url.startsWith("/api/") && url !== "/api/users")) {
    // Verbose error leak on unknown API routes (fixture).
    text(500, JSON.stringify({ error: "Error: boom", digest: "12345" }), "application/json");
  } else {
    text(404, "not found");
  }
}

async function main() {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const target = `http://127.0.0.1:${port}`;
  console.log(`fixture server on ${target}`);

  const result = await runScan(target, "full", "fixture-test");
  const found = new Set(result.findings.map((f) => f.checkId));
  console.log(`score=${result.score} grade=${result.grade} findings=${result.findings.length}`);
  for (const f of result.findings) {
    console.log(`  [${f.severity}] ${f.checkId}: ${f.title}`);
  }

  const expected = [
    "client-bundle-secrets", // sk_live_ in chunk
    "exposed-env",           // /.env reachable
    "sourcemap-leak",        // .map with sourcesContent
    "security-headers",      // no headers
    "seo-basics",            // missing title/meta + robots Disallow: /
    "unprotected-api",       // /api/users returns emails unauthenticated
    "error-verbosity",       // digest in error body
  ];
  const missing = expected.filter((id) => !found.has(id));
  if (missing.length) {
    console.error(`FAIL: checks did not fire: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("PASS: all expected signature checks fired");
  }

  // Save a sample report for visual inspection.
  writeFileSync(
    new URL("../hidden/sample-report.html", import.meta.url),
    renderReport(result, { baseUrl: "http://localhost:3000" }),
  );
  console.log("sample report written to hidden/sample-report.html");

  server.close();

  // Real-world passive sanity check (gentle: read-only, single target).
  console.log("\npassive scan of https://example.com …");
  const passive = await runScan("https://example.com", "passive", "passive-test");
  console.log(
    `score=${passive.score} grade=${passive.grade} findings=${passive.findings.length} mode=${passive.mode}`,
  );
  const fullOnly = passive.findings.filter((f) =>
    ["client-bundle-secrets", "supabase-anon-exposed", "unprotected-api"].includes(f.checkId),
  );
  if (fullOnly.length) {
    console.error("FAIL: full-only checks ran in passive mode");
    process.exitCode = 1;
  } else {
    console.log("PASS: passive mode skipped full-only checks");
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
