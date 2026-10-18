import { NextResponse } from "next/server";
import { getScan } from "@/lib/store";
import { renderBadge } from "@/lib/report";

/** GET /api/badge/{id}.svg — shields.io-style score badge for READMEs. */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const id = params.id.replace(/\.svg$/, "");
  const result = await getScan(id);
  if (!result || result.status !== "done") {
    return new NextResponse("not found", { status: 404 });
  }
  return new NextResponse(renderBadge(result), {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=300",
    },
  });
}
