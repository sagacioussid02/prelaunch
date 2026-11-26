/**
 * Extension stand-in for lib/ssrf.ts (swapped in by build.mjs).
 *
 * The server guard blocks private and loopback addresses because the
 * server must never be aimed at its own network. In the extension the
 * request leaves the user's own browser, for the site they have open, so
 * the risk is different: a page could list a script or redirect on
 * another host (a router on the LAN, say) and have the extension fetch it.
 * So the rule here is narrower than the server's: only the host being
 * scanned may be fetched, and only over http(s). That host is the one the
 * user granted access to when they pressed Scan.
 */

export const MAX_REDIRECT_HOPS = 5;

let allowedHost: string | null = null;

/** Set by the scan engine for the duration of one scan. */
export function setScanHost(host: string | null): void {
  allowedHost = host ? host.toLowerCase() : null;
}

export function scanHost(): string | null {
  return allowedHost;
}

export function isBlockedAddress(): boolean {
  return false;
}

export async function assertSafeHostname(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!allowedHost || host !== allowedHost.replace(/^\[|\]$/g, "")) {
    throw new Error(`Prelaunch only fetches the site being scanned (${allowedHost ?? "none"}), not ${hostname}`);
  }
}
