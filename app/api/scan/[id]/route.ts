import { NextResponse } from "next/server";
import { getScan } from "@/lib/store";

/** GET /api/scan/{id} — live status and per-check progress for the report page. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getScan(id).catch(() => null);
  if (!result) return new NextResponse("not found", { status: 404 });
  return NextResponse.json(
    {
      id: result.id,
      url: result.url,
      status: result.status,
      error: result.error,
      progress: result.progress ?? [],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const dynamic = "force-dynamic";
