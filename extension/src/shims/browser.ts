/**
 * Extension stand-in for lib/checks/browser.ts (swapped in by build.mjs).
 * The live-browser simulations drive headless Chromium with Playwright,
 * which can't run inside an extension, so the extension never registers
 * them. lib/scanner.ts still imports these two functions; they do nothing.
 */
import type { BrowserAvailability, ScanContext } from "../../../lib/checks/types.ts";

export async function getBrowserAvailability(_ctx: ScanContext): Promise<BrowserAvailability> {
  return { state: "unavailable", reason: "Browser simulations run on prelaunch-check.vercel.app, not in the extension." };
}

export async function closeSession(_ctx: ScanContext): Promise<void> {}

export async function getSession(_ctx: ScanContext): Promise<null> {
  return null;
}
