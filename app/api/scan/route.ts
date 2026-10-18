import { NextRequest, NextResponse } from "next/server";
import { runScan } from "@/lib/scanner";
import { getScan, newScanId, saveScan } from "@/lib/store";
import type { ScanMode, ScanResult } from "@/lib/checks/types";

/**
 * POST /api/scan { url, mode? }
 *
 * MVP prototype behavior:
 * - Returns the report id immediately; the scan runs in the background
 *   (fire-and-forget within the function lifetime — prototype simplification).
 * - mode defaults to "passive" (anonymous, read-only). "full" requires the
 *   ownership-proof flow (deploy-hook integration, v2) — accepted here only
 *   with an owner token header in prototype.
 *
 * Deploy notes (spec §6): add Upstash Ratelimit (5 scans/hour/IP) in front
 * of this route before any public launch.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { url?: string; mode?: ScanMode } | null;
  if (!body?.url) {
    return new NextResponse("missing url", { status: 400 });
  }

  let mode: ScanMode = "passive";
  if (body.mode === "full") {
    // Prototype gate: full-suite scans need the owner token until the
    // deploy-hook ownership flow exists. Env var, never shipped to client.
    const token = req.headers.get("x-prelaunch-owner-token");
    if (token !== process.env.PRELAUNCH_OWNER_TOKEN) {
      return new NextResponse("full mode requires ownership proof", { status: 403 });
    }
    mode = "full";
  }

  const id = newScanId();
  const placeholder: ScanResult = {
    id,
    url: body.url,
    mode,
    status: "running",
    startedAt: new Date().toISOString(),
    score: 0,
    grade: "?",
    findings: [],
    checkTimings: {},
  };
  await saveScan(placeholder);

  // Background the scan; the report page polls.
  runScan(body.url, mode, id)
    .then(saveScan)
    .catch(async (err) => {
      const failed = await getScan(id);
      if (failed) {
        failed.status = "failed";
        failed.finishedAt = new Date().toISOString();
        await saveScan(failed);
      }
      console.error("scan failed", id, err);
    });

  return NextResponse.json({ id });
}
