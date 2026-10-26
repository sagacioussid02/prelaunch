import { notFound } from "next/navigation";
import { getScan } from "@/lib/store";
import { renderReportBody } from "@/lib/report";
import ReportShell from "../../components/ReportShell";
import ScanProgress from "../../components/ScanProgress";

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
