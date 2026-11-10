import { NextRequest, NextResponse } from "next/server";
import { runDueMonitors } from "@/lib/runner";
import { cronSecretValid } from "@/lib/ownership";

/**
 * GET/POST /api/cron/run-monitors — scheduled monitor runner (Vercel
 * Cron hourly per vercel.json, or any external scheduler).
 * Authenticated by `Authorization: Bearer <CRON_SECRET>`; fails closed
 * when CRON_SECRET is unset, so the endpoint can never become an
 * unauthenticated way to trigger scans. Starts checks for due,
 * verified monitors only (lib/runner.ts) and returns the per-monitor
 * summary as the run's audit trail.
 */
async function handle(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  if (!cronSecretValid(token)) {
    return new NextResponse("cron auth required", { status: 403 });
  }
  try {
    const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
    const summary = await runDueMonitors(origin);
    return NextResponse.json(summary);
  } catch (err) {
    console.error("cron run-monitors failed", err);
    return new NextResponse("cron run failed", { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
