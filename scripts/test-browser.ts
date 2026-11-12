/**
 * Issue #5 self-test: live-browser availability, honest partial results,
 * and the in-browser SSRF guard.
 *
 * A. Serverless launch path (@sparticuz/chromium + playwright-core),
 *    forced via PRELAUNCH_BROWSER=serverless: a session snapshot of the
 *    local fixture actually runs and saves a screenshot.
 * B. Full scan with a launchable Chromium: all three viewport
 *    screenshots are captured, at least one real sim finding fires,
 *    the result is NOT partial.
 * C. Kill switch (PRELAUNCH_BROWSER=off): the scan completes, carries
 *    `partial`, shows the "Browser checks unavailable" warning, and the
 *    rendered report contains the partial banner + partial grade mark.
 * D. SSRF in the browser: the fixture's SSRF page tries to load
 *    http://169.254.169.254/ — the context.route guard must abort it
 *    (ERR_BLOCKED_BY_CLIENT, no response), while a loopback subresource
 *    still loads under the self-test escape hatch.
 *
 * Usage: node scripts/test-browser.ts
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { runScan } from "../lib/scanner.ts";
import { renderReportBody } from "../lib/report.ts";
import { closeSession, getBrowserAvailability, getSession } from "../lib/checks/browser.ts";
import type { ScanContext } from "../lib/checks/types.ts";

// Fixture binds 127.0.0.1; loopback is permitted for self-tests only
// (metadata/link-local/private ranges stay blocked). Never in production.
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function handler(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? "/";
  if (url === "/pixel.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(PIXEL);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  if (url === "/ssrf") {
    // No lang attribute etc. is irrelevant here; the point is the two imgs.
    res.end(
      `<html><head><title>ssrf</title></head><body><h1>ssrf fixture</h1>` +
        `<img id="meta" src="http://169.254.169.254/latest/meta-data">` +
        `<img id="loop" src="/pixel.png"></body></html>`,
    );
    return;
  }
  // No lang attribute on purpose: guarantees a real sim-a11y finding.
  res.end(
    `<html><head><title>browser fixture</title></head><body><h1>Browser fixture</h1>` +
      `<p>Some visible text for the scanner to read, render and measure.</p>` +
      `<img src="/pixel.png" alt="pixel"><a href="/ssrf">ssrf page</a></body></html>`,
  );
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function freshCtx(target: string, scanId: string): ScanContext {
  return { target, mode: "passive", cache: new Map(), scanId, screenshots: [] };
}

async function main() {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const target = `http://127.0.0.1:${port}`;
  console.log(`fixture server on ${target}`);

  // --- A. Serverless launch path -------------------------------------
  process.env.PRELAUNCH_BROWSER = "serverless";
  {
    const ctx = freshCtx(target, "browser-test-serverless");
    const avail = await getBrowserAvailability(ctx);
    check("A1 serverless availability", avail.state === "available", JSON.stringify(avail));
    const session = await getSession(ctx);
    check("A2 serverless session created", !!session);
    if (session) {
      const snap = await session.snapshot("desktop");
      check("A3 serverless snapshot ran", snap.status === 200 && !snap.navError, `status=${snap.status}`);
      check("A4 serverless screenshot saved", ctx.screenshots.some((s) => s.name === "desktop"));
    }
    await closeSession(ctx);
  }
  delete process.env.PRELAUNCH_BROWSER;

  // --- B. Full scan with a working browser ----------------------------
  // Prefer the VM's Chromium when present; otherwise whatever the
  // default resolution finds (bundled / channel / serverless fallback).
  if (!process.env.PRELAUNCH_CHROMIUM_PATH && existsSync("/opt/meta-chromium/chrome")) {
    process.env.PRELAUNCH_CHROMIUM_PATH = "/opt/meta-chromium/chrome";
  }
  {
    const result = await runScan(target, "full", "browser-test-full");
    const shotNames = (result.screenshots ?? []).map((s) => s.name).sort();
    check(
      "B1 three viewport screenshots",
      ["desktop", "mobile", "tablet"].every((n) => shotNames.includes(n)),
      shotNames.join(","),
    );
    check("B2 result not partial", result.partial === undefined, result.partial ?? "");
    check(
      "B3 no unavailable warning",
      !result.findings.some((f) => f.title.startsWith("Browser checks unavailable")),
    );
    check(
      "B4 real sim findings fired",
      result.findings.some((f) => f.checkId.startsWith("sim-")),
      result.findings.filter((f) => f.checkId.startsWith("sim-")).map((f) => f.checkId).join(","),
    );
  }

  // --- C. Kill switch: honest partial ---------------------------------
  process.env.PRELAUNCH_BROWSER = "off";
  {
    const result = await runScan(target, "full", "browser-test-off");
    check("C1 partial flagged", typeof result.partial === "string" && result.partial.includes("PRELAUNCH_BROWSER=off"), result.partial ?? "(none)");
    check(
      "C2 unavailable warning present",
      result.findings.some((f) => f.checkId === "sim-load" && f.severity === "warning" && f.title.startsWith("Browser checks unavailable")),
    );
    check("C3 no screenshots", (result.screenshots ?? []).length === 0);
    const html = renderReportBody(result, { baseUrl: "http://localhost:3000" });
    check("C4 report shows partial banner", html.includes("Partial result — browser checks unavailable"));
    check("C5 grade marked partial", html.includes("· partial"));
    // Same partial result with every finding cleared: still no launch verdict.
    const clean = renderReportBody({ ...result, findings: [] }, { baseUrl: "http://localhost:3000" });
    check("C6 partial report with no blockers never says ready to launch", !clean.includes("Ready to launch"));
    check("C7 partial report with no blockers says it's not a launch verdict", clean.includes("not a launch verdict yet"));
    const { partial: _p, ...complete } = result;
    const full = renderReportBody({ ...complete, findings: [] }, { baseUrl: "http://localhost:3000" });
    check("C8 complete report with no blockers says ready to launch", full.includes("Ready to launch"));
  }
  delete process.env.PRELAUNCH_BROWSER;

  // --- D. In-browser SSRF guard ---------------------------------------
  {
    const ctx = freshCtx(target, "browser-test-ssrf");
    const session = await getSession(ctx);
    check("D1 session available for SSRF test", !!session);
    if (session) {
      const outcome = await session.withPage("desktop", true, async (page) => {
        const failed: Array<{ url: string; why: string }> = [];
        const responded: string[] = [];
        page.on("requestfailed", (r) => failed.push({ url: r.url(), why: r.failure()?.errorText ?? "" }));
        page.on("response", (r) => responded.push(r.url()));
        await page.goto(`${target}/ssrf`, { waitUntil: "load", timeout: 15000 });
        await page.waitForTimeout(600);
        const imgs = await page.evaluate(() => {
          const m = document.querySelector<HTMLImageElement>("#meta");
          const l = document.querySelector<HTMLImageElement>("#loop");
          return {
            meta: { complete: !!m?.complete, width: m?.naturalWidth ?? -1 },
            loop: { complete: !!l?.complete, width: l?.naturalWidth ?? -1 },
          };
        });
        return { failed, responded, imgs };
      });
      const metaFailure = outcome.failed.find((f) => f.url.includes("169.254.169.254"));
      check("D2 metadata request aborted by guard", !!metaFailure && metaFailure.why.includes("BLOCKED_BY_CLIENT"), JSON.stringify(metaFailure ?? {}));
      check("D3 no response from metadata address", !outcome.responded.some((u) => u.includes("169.254.169.254")));
      check("D4 metadata image never rendered", outcome.imgs.meta.width === 0, JSON.stringify(outcome.imgs.meta));
      check("D5 loopback subresource allowed under hatch", outcome.imgs.loop.width > 0, JSON.stringify(outcome.imgs.loop));
    }
    await closeSession(ctx);
  }

  server.close();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
