import { NextResponse } from "next/server";
import { getScan, getShot } from "@/lib/store";
import { renderReport } from "@/lib/report";

/** GET /api/report/{id}[?format=json] — downloadable report; HTML embeds screenshots so it works offline. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getScan(id).catch(() => null);
  if (!result || result.status !== "done") return new NextResponse("not found", { status: 404 });

  const host = new URL(result.url).hostname.replace(/[^a-z0-9.-]/gi, "_");
  const stamp = (result.finishedAt ?? result.startedAt).slice(0, 10);
  const base = `prelaunch-${host}-${stamp}`;

  if (new URL(req.url).searchParams.get("format") === "json") {
    return new NextResponse(JSON.stringify(result, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${base}.json"`,
      },
    });
  }

  const inlineShots: Record<string, string> = {};
  for (const s of result.screenshots ?? []) {
    const data = await getShot(id, s.name).catch(() => null);
    if (data) inlineShots[s.name] = `data:image/jpeg;base64,${data.toString("base64")}`;
  }
  return new NextResponse(renderReport(result, { baseUrl: "", inlineShots }), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}.html"`,
    },
  });
}
