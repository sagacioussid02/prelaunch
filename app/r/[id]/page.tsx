import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getScanChecked as getScan } from "@/lib/scanstatus";
import { renderReportBody } from "@/lib/report";
import ReportShell from "../../components/ReportShell";
import ScanProgress from "../../components/ScanProgress";

/** Issue #7: reports are shareable by link but must not be indexed. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/** Report page: /r/{id}. Public, no login required to view (per spec §5). */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getScan(id);
  if (!result) notFound();

  if (result.status !== "done") {
    return <ScanProgress id={id} url={result.url} />;
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "";
  return <ReportShell html={renderReportBody(result, { baseUrl, monitorSlot: true, downloads: true })} url={result.url} />;
}

export const dynamic = "force-dynamic";
