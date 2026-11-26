/**
 * Test-only stand-in for ExtPay (build.mjs --test). Paid status comes from
 * chrome.storage.local "test:paid", so the test suite can flip it without
 * reaching extensionpay.com. Never part of a release build.
 */
export function ExtPay(_id: string) {
  return {
    startBackground() {},
    async getUser() {
      const { "test:paid": paid, "test:offline": offline } = await chrome.storage.local.get(["test:paid", "test:offline"]);
      if (offline) throw new Error("network down (test)");
      return { paid: paid === true, email: paid ? "buyer@example.test" : null, plan: null };
    },
    async openPaymentPage() {
      await chrome.storage.local.set({ "test:opened": "payment" });
    },
    async openLoginPage() {
      await chrome.storage.local.set({ "test:opened": "login" });
    },
  };
}
