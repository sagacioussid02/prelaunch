/**
 * Prelaunch for Chrome — service worker.
 *
 * Owns the two things the popup must not decide for itself: whether the
 * user has paid (asked of ExtensionPay here, never taken from the popup),
 * and running the scan. The popup only sends messages.
 *
 * ExtPay.js is loaded unmodified by importScripts() ahead of this file
 * (see build.mjs and manifest.json), so it stays a separate, replaceable
 * file as its LGPL licence expects.
 */

import { scanSite, type ExtensionScanResult, type Tier } from "./engine.ts";
import { EXTPAY_ID } from "./config.ts";

declare const ExtPay: (id: string) => {
  startBackground(): void;
  getUser(): Promise<{ paid: boolean; email: string | null }>;
  openPaymentPage(plan?: string): Promise<void>;
  openLoginPage(): Promise<void>;
};

ExtPay(EXTPAY_ID).startBackground();

/** ExtPay's docs: re-create the client inside callbacks rather than reuse a top-level one. */
function extpay() {
  return ExtPay(EXTPAY_ID);
}

export type Request =
  | { type: "plan" }
  | { type: "scan"; target: string }
  | { type: "cached"; target: string }
  | { type: "pay" }
  | { type: "login" };

export interface PlanStatus {
  paid: boolean;
  email: string | null;
  /** Set when ExtensionPay couldn't be reached; the popup then offers the free scan only. */
  error?: string;
}

async function planStatus(): Promise<PlanStatus> {
  try {
    const user = await extpay().getUser();
    return { paid: user.paid === true, email: user.email ?? null };
  } catch (err) {
    return { paid: false, email: null, error: `Couldn't reach ExtensionPay to check your plan (${String((err as Error)?.message ?? err)}).` };
  }
}

const CACHE_MS = 10 * 60 * 1000;

function cacheKey(target: string): string {
  return `result:${target}`;
}

async function handle(msg: Request): Promise<unknown> {
  switch (msg.type) {
    case "plan":
      return planStatus();
    case "cached": {
      const key = cacheKey(msg.target);
      const stored = (await chrome.storage.session.get(key))[key] as { at: number; result: ExtensionScanResult } | undefined;
      if (!stored || Date.now() - stored.at > CACHE_MS) return null;
      // A cached full report is only shown to someone who still has the full plan.
      if (stored.result.tier === "full" && !(await planStatus()).paid) return null;
      return stored.result;
    }
    case "scan": {
      const plan = await planStatus();
      const tier: Tier = plan.paid ? "full" : "quick";
      const result = await scanSite(msg.target, tier);
      await chrome.storage.session.set({ [cacheKey(result.url)]: { at: Date.now(), result } });
      return { result, plan };
    }
    case "pay":
      await extpay().openPaymentPage();
      return { ok: true };
    case "login":
      await extpay().openLoginPage();
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse) => {
  // Only this extension's own pages may drive it.
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object") return false;
  handle(msg).then(
    (value) => sendResponse({ ok: true, value }),
    (err) => sendResponse({ ok: false, error: String((err as Error)?.message ?? err) }),
  );
  return true;
});
