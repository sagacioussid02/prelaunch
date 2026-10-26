import { NextRequest, NextResponse } from "next/server";
import { runMonitor, verifyToken } from "@/lib/monitor";

/**
 * POST /api/monitor/{id}/deploy?token=…  — call this from your deploy hook
 * (Vercel "Deployment Ready" webhook, GitHub Action, curl). Ignores the body:
 * it only ever audits the URL registered for the monitor.
 *
 * POST /api/monitor/{id}/deploy?manual=1 — dashboard "Run now" button; no
 * token, throttled by the monitor cooldown.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manual = req.nextUrl.searchParams.get("manual") === "1";
  if (!manual) {
    const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-prelaunch-token");
    if (!(await verifyToken(id, token))) return new NextResponse("unauthorized", { status: 401 });
  }
  const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
  const r = await runMonitor(id, manual ? "manual" : "deploy", origin);
  if (r.ok) return NextResponse.json({ scanId: r.scanId, report: `${origin}/r/${r.scanId}` }, { status: 202 });
  if (r.reason === "missing") return new NextResponse("not found", { status: 404 });
  return new NextResponse(r.reason === "cooldown" ? "audited too recently; try again shortly" : "audit already running", {
    status: 429,
    headers: r.retryInMs ? { "Retry-After": String(Math.ceil(r.retryInMs / 1000)) } : {},
  });
}
