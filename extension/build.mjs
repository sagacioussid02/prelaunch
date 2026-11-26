// Builds the extension into extension/dist (load it unpacked from there).
//   node build.mjs          release build (real ExtPay)
//   node build.mjs --test   test build: fake ExtPay driven by chrome.storage,
//                           and every site pre-allowed so no permission prompt
//   node build.mjs --zip    release build plus prelaunch-chrome-<version>.zip
//                           for the Chrome Web Store
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../lib");
const out = resolve(here, "dist");
const test = process.argv.includes("--test");
const zip = process.argv.includes("--zip");

// Server-only modules in lib/ and their extension stand-ins (see src/shims).
const SWAPS = new Map([
  [resolve(lib, "checks/index.ts"), resolve(here, "src/shims/registry.ts")],
  [resolve(lib, "checks/browser.ts"), resolve(here, "src/shims/browser.ts")],
  [resolve(lib, "ssrf.ts"), resolve(here, "src/shims/ssrf.ts")],
]);

const swapPlugin = {
  name: "prelaunch-extension-swaps",
  setup(b) {
    b.onResolve({ filter: /\.ts$/ }, (args) => {
      if (!args.resolveDir) return undefined;
      const abs = resolve(args.resolveDir, args.path);
      const swap = SWAPS.get(abs);
      return swap ? { path: swap } : undefined;
    });
    // Anything that still reaches for Node or Playwright is a bug: fail the build.
    b.onResolve({ filter: /^(node:|playwright|@sparticuz|pg$|@vercel\/blob)/ }, (args) => ({
      errors: [{ text: `${args.path} can't run in the extension (imported from ${args.importer})` }],
    }));
  },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  target: "chrome116",
  platform: "browser",
  legalComments: "none",
  plugins: [swapPlugin],
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
};

await build({ ...common, entryPoints: [resolve(here, "src/background.ts")], outfile: resolve(out, "background.js") });
await build({ ...common, entryPoints: [resolve(here, "src/popup.ts")], outfile: resolve(out, "popup.js") });

if (test) {
  await build({
    ...common,
    entryPoints: [resolve(here, "src/shims/extpay-fake.ts")],
    globalName: "__extpayFake",
    footer: { js: "var ExtPay = __extpayFake.ExtPay;" },
    outfile: resolve(out, "ExtPay.js"),
  });
} else {
  // ExtPay ships unmodified, as its own file (LGPL-3.0).
  cpSync(resolve(here, "node_modules/extpay/dist/ExtPay.js"), resolve(out, "ExtPay.js"));
}

// The service worker loads ExtPay first, then the bundle.
const bg = readFileSync(resolve(out, "background.js"), "utf8");
writeFileSync(resolve(out, "background.js"), `importScripts("ExtPay.js");\n${bg}`);

cpSync(resolve(here, "static"), out, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(here, "static/manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));
manifest.version = pkg.version;
if (test) {
  manifest.name += " (test build)";
  manifest.host_permissions = ["<all_urls>"];
}
writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

if (zip) {
  const name = `prelaunch-chrome-${pkg.version}.zip`;
  rmSync(resolve(here, name), { force: true });
  execFileSync("zip", ["-qr", resolve(here, name), "."], { cwd: out });
  console.log(`packaged ${name}`);
}
console.log(`built ${test ? "test" : "release"} extension into extension/dist`);
