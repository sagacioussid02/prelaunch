"use client";

import { useState } from "react";

interface Created {
  id: string;
  dashboard: string;
  deployHook: string;
  plan?: { id: string; name: string; maxMonitors: number };
  usage?: { monitors: number; maxMonitors: number };
  note?: string;
}

export default function MonitorCta({ url }: { url: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [upgradeHint, setUpgradeHint] = useState("");
  const [existingDashboard, setExistingDashboard] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    setUpgradeHint("");
    setExistingDashboard("");
    const res = await fetch("/api/monitor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: fd.get("url"),
        alertWebhook: fd.get("alertWebhook") || undefined,
        email: fd.get("email") || undefined,
      }),
    }).catch(() => null);
    setBusy(false);
    if (!res) {
      setError("Could not reach the server.");
      return;
    }
    if (!res.ok) {
      // Plan rejections (402 plan limit / full-mode, 409 duplicate)
      // arrive as JSON with a human reason and an upgrade hint — show
      // those, not the raw payload. Anything else keeps the plain
      // text error the API has always returned.
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as {
          error?: string;
          code?: string;
          upgrade?: string;
          dashboard?: string;
        };
        if (parsed.error) {
          setError(parsed.error);
          if (parsed.upgrade) setUpgradeHint(parsed.upgrade);
          if (parsed.code === "duplicate" && parsed.dashboard) {
            setExistingDashboard(parsed.dashboard);
          }
          return;
        }
      } catch {
        // Not JSON — fall through to the raw text.
      }
      setError(text);
      return;
    }
    setCreated((await res.json()) as Created);
  }

  if (created) {
    return (
      <div className="panel">
        <h3>Monitoring is on</h3>
        <p className="muted">
          Add this deploy hook to your project. It is shown once, so copy it now. Each call audits <b>{url}</b> and alerts on new blockers.
        </p>
        {created.plan && (
          <p className="muted">
            Plan: <b>{created.plan.name}</b>
            {created.usage
              ? ` — ${created.usage.monitors} of ${created.usage.maxMonitors} monitor${created.usage.maxMonitors === 1 ? "" : "s"} used`
              : ""}
            .
          </p>
        )}
        {created.note && <p className="muted">Note: {created.note}</p>}
        <div className="code">
          <span>{created.deployHook}</span>
          <button
            className="btn secondary"
            style={{ padding: "8px 12px", fontSize: 13 }}
            onClick={() => {
              navigator.clipboard.writeText(created.deployHook);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <ol className="steps">
          <li>
            Vercel: Project Settings → Webhooks → add the URL for the <b>Deployment Ready</b> (production) event.
          </li>
          <li>
            Or from CI: <code>curl -X POST &quot;&lt;hook&gt;&quot;</code> after your deploy step.
          </li>
          <li>The first audit becomes the baseline; later ones alert only on blockers that are new.</li>
        </ol>
        <a className="btn" href={created.dashboard} style={{ textDecoration: "none", display: "inline-block" }}>
          Open dashboard →
        </a>
      </div>
    );
  }

  return (
    <form className="panel" onSubmit={onSubmit}>
      <h3>Monitor every deploy</h3>
      <p className="muted">Auto-audit each production deploy and get alerted on new blockers.</p>
      <label>Site to monitor</label>
      <input type="url" name="url" defaultValue={url} required />
      <label>Alert webhook (optional: Slack or Discord incoming-webhook URL)</label>
      <input type="url" name="alertWebhook" placeholder="https://hooks.slack.com/services/…" />
      <label>Email for regression alerts (optional — also identifies your plan: Free includes 1 monitor)</label>
      <input type="email" name="email" placeholder="you@example.com" />
      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Enabling…" : "Enable monitoring"}
      </button>
      <p className="err">{error}</p>
      {upgradeHint && <p className="muted">{upgradeHint}</p>}
      {existingDashboard && (
        <p>
          <a href={existingDashboard}>Open the existing monitor →</a>
        </p>
      )}
    </form>
  );
}
