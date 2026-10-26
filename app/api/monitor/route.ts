import { NextRequest, NextResponse } from "next/server";
import { createMonitor } from "@/lib/monitor";

const MAX_PER_HOUR = 10;
const hits = new Map<string, number[]>();

/** POST /api/monitor { url, alertWebhook? } → { id, token, deployHook } (token is shown once). */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => t > now - 3_600_000);
  if (recent.length >= MAX_PER_HOUR) return new NextResponse("rate limit exceeded", { status: 429 });
  recent.push(now);
  hits.set(ip, recent);

  const body = (await req.json().catch(() => null)) as { url?: string; alertWebhook?: string } | null;
  if (!body?.url) return new NextResponse("missing url", { status: 400 });
  try {
    const m = await createMonitor(body.url, body.alertWebhook);
    const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
    return NextResponse.json({
      id: m.id,
      url: m.url,
      dashboard: `${origin}/m/${m.id}`,
      deployHook: `${origin}/api/monitor/${m.id}/deploy?token=${m.token}`,
    });
  } catch (err) {
    return new NextResponse(String((err as Error).message ?? err).slice(0, 200), { status: 400 });
  }
}
