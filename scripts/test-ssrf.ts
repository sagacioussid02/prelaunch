/**
 * Direct checks for lib/ssrf.ts (issue #8).
 *
 * Run: node scripts/test-ssrf.ts
 *
 * Covers the acceptance cases from issue #8:
 * - isBlockedAddress matrix: loopback, RFC1918, link-local (cloud
 *   metadata), 0.0.0.0, multicast/reserved, IPv6 loopback/ULA/link-local,
 *   and IPv4-mapped IPv6 (mapped loopback blocked, mapped public allowed).
 * - assertSafeHostname on IP literals (no DNS involved): blocked literals
 *   throw, a public literal passes. The PRELAUNCH_ALLOW_LOOPBACK escape
 *   hatch admits loopback ONLY — link-local/metadata still throws.
 * - Redirect hop: a local server (loopback admitted via the escape hatch)
 *   302-redirects to the link-local metadata address; fetchWithTimeout
 *   must re-validate the hop and reject it instead of following. A
 *   same-server redirect to a normal path still succeeds.
 *
 * No external network needed: every case is an IP literal or a local
 * fixture server.
 */
import { createServer } from "node:http";
import { isBlockedAddress, assertSafeHostname } from "../lib/ssrf.ts";
import { fetchWithTimeout } from "../lib/checks/types.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

async function assertThrows(
  fn: () => Promise<unknown>,
  msg: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert(
      err instanceof Error && /SSRF guard/.test(err.message),
      `${msg} (threw: ${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }
  assert(false, `${msg} (did not throw)`);
}

// The escape hatch must be OFF for the strict cases. It is read lazily by
// lib/ssrf.ts at call time, so toggling process.env between sections works.
delete process.env.PRELAUNCH_ALLOW_LOOPBACK;

// --- isBlockedAddress matrix -------------------------------------------------
const blocked = [
  "127.0.0.1", // loopback
  "127.53.0.9", // loopback /8
  "10.1.2.3", // RFC1918
  "172.16.0.1", // RFC1918 low edge
  "172.31.255.255", // RFC1918 high edge
  "192.168.0.1", // RFC1918
  "169.254.169.254", // link-local: cloud instance metadata
  "0.0.0.0", // "this network"
  "224.0.0.1", // multicast
  "::1", // IPv6 loopback
  "::", // IPv6 unspecified
  "fe80::1", // IPv6 link-local
  "fd00::1", // IPv6 unique local
  "::ffff:127.0.0.1", // IPv4-mapped loopback
  "::ffff:169.254.169.254", // IPv4-mapped metadata
  "not-an-ip", // garbage fails closed
];
for (const ip of blocked) {
  assert(isBlockedAddress(ip) === true, `blocked: ${ip}`);
}
const allowed = [
  "8.8.8.8",
  "1.1.1.1",
  "172.32.0.1", // just outside the RFC1918 172.16/12 range
  "2606:4700:4700::1111", // public IPv6
  "::ffff:8.8.8.8", // IPv4-mapped public
];
for (const ip of allowed) {
  assert(isBlockedAddress(ip) === false, `allowed: ${ip}`);
}

// --- assertSafeHostname on IP literals (no DNS) ------------------------------
await assertThrows(
  () => assertSafeHostname("127.0.0.1"),
  "assertSafeHostname rejects loopback literal",
);
await assertThrows(
  () => assertSafeHostname("169.254.169.254"),
  "assertSafeHostname rejects metadata literal",
);
await assertThrows(
  () => assertSafeHostname("192.168.1.10"),
  "assertSafeHostname rejects RFC1918 literal",
);
await assertThrows(
  () => assertSafeHostname("::ffff:127.0.0.1"),
  "assertSafeHostname rejects IPv4-mapped loopback literal",
);
await assertSafeHostname("8.8.8.8");
assert(true, "assertSafeHostname admits a public literal");

// --- Escape hatch: loopback only, never metadata -----------------------------
process.env.PRELAUNCH_ALLOW_LOOPBACK = "1";
await assertSafeHostname("127.0.0.1");
assert(true, "escape hatch admits loopback");
await assertThrows(
  () => assertSafeHostname("169.254.169.254"),
  "escape hatch still rejects metadata literal",
);
await assertThrows(
  () => assertSafeHostname("10.0.0.5"),
  "escape hatch still rejects RFC1918 literal",
);

// --- Redirect hop re-validation ----------------------------------------------
const server = createServer((req, res) => {
  if (req.url === "/hop") {
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
    res.end();
  } else if (req.url === "/ok") {
    res.writeHead(302, { Location: "/target" });
    res.end();
  } else if (req.url === "/target") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello");
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("fixture server: no address");
const base = `http://127.0.0.1:${addr.port}`;
try {
  const okRes = await fetchWithTimeout(`${base}/ok`, 5000);
  assert(
    okRes.status === 200 && (await okRes.text()) === "hello",
    "same-server redirect to a normal path succeeds",
  );
  await assertThrows(
    () => fetchWithTimeout(`${base}/hop`, 5000),
    "redirect hop to the metadata address is rejected",
  );
} finally {
  server.close();
  delete process.env.PRELAUNCH_ALLOW_LOOPBACK;
}

console.log("test-ssrf: ALL PASS");
