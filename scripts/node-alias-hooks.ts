/**
 * Shared test helper: lets plain `node` import route modules and lib files
 * that use Next-only resolution. Maps the "@/..." alias to the repo root
 * and "next/server" to its server.js entry (Next's package exports don't
 * resolve that subpath under plain node ESM). Same approach as the hook
 * inside scripts/test-waitlist.ts, factored out for the Phase 1 tests.
 *
 * Usage (before importing the modules under test):
 *   await registerAliasHooks(tempDir);
 */
import { promises as fs } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function registerAliasHooks(tempDir: string): Promise<void> {
  const rootUrl = new URL("../", import.meta.url).href;
  // Customization hooks run in a worker thread and need a real file.
  const hooksFile = join(tempDir, "alias-hooks.mjs");
  await fs.writeFile(
    hooksFile,
    `
import { existsSync } from "node:fs";
const ROOT = ${JSON.stringify(rootUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return { url: ROOT + "node_modules/next/server.js", shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    for (const suffix of [".ts", ".tsx", ".js", ".mjs"]) {
      const url = ROOT + rel + suffix;
      if (existsSync(new URL(url))) return { url, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
`,
  );
  register(pathToFileURL(hooksFile));
}
