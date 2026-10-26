import { notFound } from "next/navigation";
import { getMonitor } from "@/lib/monitor";
import RunNow from "../../components/RunNow";

const GRADE_COLOR: Record<string, string> = { "A+": "#22c55e", A: "#4ade80", B: "#a3e635", C: "#facc15", D: "#fb923c", F: "#f87171" };

/** Monitor dashboard: /m/{id}. Lists every deploy audit and flags new blockers. */
export default async function MonitorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await getMonitor(id).catch(() => null);
  if (!m) notFound();
  const runs = [...m.runs].reverse();
  const alerts = runs.filter((r) => r.newBlockers.length);

  return (
    <main className="page">
      <h1 className="hero-title" style={{ fontSize: 34 }}>Deploy monitor</h1>
      <p className="hero-sub" style={{ fontSize: 16, wordBreak: "break-all" }}>{m.url}</p>
      <RunNow id={m.id} running={m.running} />

      <h2 className="section-title">Alerts</h2>
      {alerts.length === 0 ? (
        <p className="muted">No new blockers since monitoring started.</p>
      ) : (
        alerts.map((r) => (
          <div key={r.scanId} className="item" style={{ borderColor: "#7f1d1d", marginBottom: 10 }}>
            <span className="dot" style={{ background: "#f87171" }}>{r.newBlockers.length}</span>
            <div>
              <div className="t">New blocker{r.newBlockers.length > 1 ? "s" : ""} after the deploy at {new Date(r.at).toLocaleString()}</div>
              {r.newBlockers.map((b) => (
                <div key={b.checkId + b.title} className="d">• {b.title} — {b.fix}</div>
              ))}
              <div className="d">{r.alertSent ? "Alert webhook notified." : m.hasAlertWebhook ? "Alert webhook failed." : "No alert webhook configured."}</div>
            </div>
          </div>
        ))
      )}

      <h2 className="section-title">Audit history</h2>
      {runs.length === 0 ? (
        <p className="muted">No audits yet. Call your deploy hook or press &ldquo;Run audit now&rdquo;. The first one becomes the baseline.</p>
      ) : (
        runs.map((r, i) => (
          <a key={r.scanId} className="run rise" style={{ ["--i" as string]: i }} href={`/r/${r.scanId}`}>
            <span className="badge" style={{ background: GRADE_COLOR[r.grade] ?? "#9ca3af" }}>{r.grade} · {r.score}</span>
            <div>
              <span className="tag">{r.trigger}</span>
              {r.newBlockers.length > 0 && <span className="tag new">{r.newBlockers.length} new blocker</span>}
              <div className="d" style={{ marginTop: 4 }}>
                {r.blockers} blockers · {r.warnings} warnings · {new Date(r.at).toLocaleString()}
              </div>
            </div>
            <span className="muted" style={{ margin: 0 }}>Report →</span>
          </a>
        ))
      )}
    </main>
  );
}

export const dynamic = "force-dynamic";
