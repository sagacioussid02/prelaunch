/**
 * SSRF guard for server-side fetching (security review 2026-10-18, HIGH #2).
 *
 * Every URL the scanner fetches must pass through assertSafeHostname() before
 * the request is issued, and redirects are followed manually (see
 * fetchWithTimeout in lib/checks/types.ts) so each hop is re-validated —
 * a redirect can never hop from a public host to an internal address.
 *
 * Blocked: loopback (127.0.0.0/8, ::1), link-local 169.254.0.0/16 (cloud
 * instance metadata), RFC1918 private ranges, 0.0.0.0, multicast/reserved.
 * Unresolvable hostnames fail closed.
 *
 * Escape hatch: PRELAUNCH_ALLOW_LOOPBACK=1 permits loopback addresses ONLY
 * (never metadata/link-local/private). Used by scripts/test-scan.ts for its
 * local fixture server. Never set this in a deployed environment.
 *
 * Prototype-grade note: validation happens at request time via a fresh DNS
 * lookup per hop, which closes the naive redirect case. A production
 * deployment should additionally pin the validated IP (connect to the IP
 * with the original Host header / TLS SNI) to fully close DNS-rebinding
 * (TOCTOU) attacks.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_REDIRECT_HOPS = 5;

/** True when an IP address must never be fetched server-side. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local: cloud metadata
    if (a === 0) return true; // "this network"
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (family === 6) {
    const n = ip.toLowerCase();
    if (n === "::1" || n === "::") return true; // loopback / unspecified
    if (n.startsWith("fe80:")) return true; // link-local
    if (n.startsWith("fc") || n.startsWith("fd")) return true; // unique local
    if (n.startsWith("ff")) return true; // multicast
    const mapped = n.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true; // not a parseable IP literal — fail closed
}

function isLoopback(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return ip.split(".").map(Number)[0] === 127;
  if (family === 6) return ip.toLowerCase() === "::1";
  return false;
}

/**
 * Permit loopback only when the self-test escape hatch is enabled.
 * Read lazily (not at module load) because test scripts set the env var
 * after their imports are hoisted.
 */
function allowLoopback(): boolean {
  return process.env.PRELAUNCH_ALLOW_LOOPBACK === "1";
}

/**
 * Resolve `hostname` and throw unless every resolved address is safe.
 * Throws on: unresolvable host, blocked address, non-IP garbage.
 */
export async function assertSafeHostname(hostname: string): Promise<void> {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!clean) throw new Error("SSRF guard: empty hostname");
  const loopbackOk = allowLoopback();

  if (isIP(clean)) {
    if (isBlockedAddress(clean) && !(loopbackOk && isLoopback(clean))) {
      throw new Error(`SSRF guard: blocked target address (${hostname})`);
    }
    return;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(clean, { all: true });
  } catch {
    throw new Error(`SSRF guard: could not resolve target host (${hostname})`);
  }
  if (addrs.length === 0) {
    throw new Error(`SSRF guard: no addresses for host (${hostname})`);
  }
  for (const { address } of addrs) {
    if (isBlockedAddress(address) && !(loopbackOk && isLoopback(address))) {
      throw new Error(
        `SSRF guard: target resolves to a blocked address (${hostname})`,
      );
    }
  }
}
