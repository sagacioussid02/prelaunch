import { NextResponse } from "next/server";
import { getShot } from "@/lib/store";

/** GET /api/shot/{id}/{desktop|tablet|mobile}.jpg — screenshots from the live browser run. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name: raw } = await params;
  const name = raw.replace(/\.jpg$/, "");
  if (!["desktop", "tablet", "mobile"].includes(name)) return new NextResponse("not found", { status: 404 });
  const data = await getShot(id, name).catch(() => null);
  if (!data) return new NextResponse("not found", { status: 404 });
  return new NextResponse(new Uint8Array(data), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" },
  });
}
