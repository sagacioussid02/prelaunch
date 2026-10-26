"use client";

import { useState } from "react";

interface Created {
  id: string;
  dashboard: string;
  deployHook: string;
}

export default function MonitorCta({ url }: { url: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    const res = await fetch("/api/monitor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: fd.get("url"), alertWebhook: fd.get("alertWebhook") || undefined }),
    }).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) {
      setError(res ? await res.text() : "Could not reach the server.");
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
      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Enabling…" : "Enable monitoring"}
      </button>
      <p className="err">{error}</p>
    </form>
  );
}
