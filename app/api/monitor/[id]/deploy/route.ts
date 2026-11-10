import { NextRequest, NextResponse } from "next/server";
import { runMonitor, verifyToken } from "@/lib/monitor";
import { keepAlive } from "@/lib/background";
import { verifyRunGrant } from "@/lib/runlink";

/**
 * POST /api/monitor/{id}/deploy?token=…  — call this from your deploy hook
 * (Vercel "Deployment Ready" webhook, GitHub Action, curl). Ignores the body:
 * it only ever audits the URL registered for the monitor.
 *
 * POST /api/monitor/{id}/deploy?manual=1 — dashboard "Run now" button.
 * Issue #6: knowing the monitor id is no longer enough. A manual run needs
 * the monitor's deploy token (`x-prelaunch-token` header or `token`) OR a
 * signed short-lived dashboard grant (`grant=…`, lib/runlink.ts) minted for
 * this monitor. Without either: 401. Still throttled by the cooldown.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manual = req.nextUrl.searchParams.get("manual") === "1";
  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-prelaunch-token");
  const authorized =
    (await verifyToken(id, token)) ||
    (manual && verifyRunGrant(id, req.nextUrl.searchParams.get("grant")));
  if (!authorized) return new NextResponse("unauthorized", { status: 401 });
  const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
  const r = await runMonitor(id, manual ? "manual" : "deploy", origin);
  if (r.ok) {
    // Keep the scan and its diff/alert/email recording alive past the response (issue #4).
    keepAlive(r.done);
    return NextResponse.json({ scanId: r.scanId, report: `${origin}/r/${r.scanId}` }, { status: 202 });
  }
  if (r.reason === "missing") return new NextResponse("not found", { status: 404 });
  return new NextResponse(r.reason === "cooldown" ? "audited too recently; try again shortly" : "audit already running", {
    status: 429,
    headers: r.retryInMs ? { "Retry-After": String(Math.ceil(r.retryInMs / 1000)) } : {},
  });
}

/** Covers the monitor scan run in after() (SCAN_DEADLINE_MS is 4 minutes). */
export const maxDuration = 300;
