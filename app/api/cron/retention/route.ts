import { NextRequest, NextResponse } from "next/server";
import { runRetention } from "@/lib/retention";
import { cronSecretValid } from "@/lib/ownership";

/**
 * GET/POST /api/cron/retention — daily retention sweep (issue #3; Vercel
 * Cron per vercel.json). Deletes anonymous scan reports older than 30 days
 * with their screenshots; scans referenced by a monitor's history or
 * baseline are kept (lib/retention.ts).
 * Authenticated by `Authorization: Bearer <CRON_SECRET>`; fails closed
 * when CRON_SECRET is unset, like /api/cron/run-monitors.
 */
async function handle(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  if (!cronSecretValid(token)) {
    return new NextResponse("cron auth required", { status: 403 });
  }
  try {
    const summary = await runRetention();
    console.log(JSON.stringify({ event: "retention", ...summary }));
    return NextResponse.json(summary);
  } catch (err) {
    console.error("cron retention failed", err);
    return new NextResponse("retention run failed", { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export const dynamic = "force-dynamic";
