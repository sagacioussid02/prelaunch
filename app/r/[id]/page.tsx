import { notFound } from "next/navigation";
import { getScan } from "@/lib/store";
import { renderReport } from "@/lib/report";

/** Report page: /r/{id}. Public, no login required to view (per spec §5). */
export default async function ReportPage({ params }: { params: { id: string } }) {
  const result = await getScan(params.id);
  if (!result) notFound();

  if (result.status === "running") {
    return (
      <main style={{ textAlign: "center", padding: 72, fontFamily: "sans-serif" }}>
        <h1>Scanning…</h1>
        <p style={{ color: "#64748b" }}>Your audit is running. This page refreshes when it&rsquo;s done.</p>
        <meta httpEquiv="refresh" content="5" />
      </main>
    );
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "";
  return (
    <div dangerouslySetInnerHTML={{ __html: renderReport(result, { baseUrl }) }} />
  );
}

export const dynamic = "force-dynamic";
