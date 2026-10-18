/**
 * One-off CLI: scan a URL and print findings + write the report HTML.
 *
 * Usage:
 *   node scripts/scan-once.ts https://example.com [--full] [--out report.html]
 *
 * --full enables the full suite (bundle secret scanning, auth probes).
 * Only use on sites you own — anonymous scans must stay passive.
 */
import { writeFileSync } from "node:fs";
import { runScan } from "../lib/scanner.ts";
import { renderReport } from "../lib/report.ts";
import { newScanId } from "../lib/store.ts";

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) {
    console.error("usage: node scripts/scan-once.ts <url> [--full] [--out report.html]");
    process.exit(1);
  }
  const mode = args.includes("--full") ? "full" : "passive";
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : "report.html";

  const result = await runScan(url, mode, newScanId());
  console.log(`\n${result.url} — score ${result.score} (${result.grade}), mode=${mode}`);
  console.log(`duration: ${result.durationMs}ms, findings: ${result.findings.length}\n`);
  for (const f of result.findings) {
    console.log(`[${f.severity}] ${f.checkId}`);
    console.log(`  ${f.title}`);
    console.log(`  where: ${f.location}`);
    console.log(`  fix:   ${f.fix}\n`);
  }
  writeFileSync(out, renderReport(result, { baseUrl: "http://localhost:3000" }));
  console.log(`report → ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
