"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RunNow({ id, running }: { id: string; running: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState(running ? "An audit is running…" : "");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const res = await fetch(`/api/monitor/${id}/deploy?manual=1`, { method: "POST" }).catch(() => null);
    setMsg(res?.status === 202 ? "Audit started. Refresh in about a minute." : res ? await res.text() : "Request failed.");
    setBusy(false);
    if (res?.status === 202) setTimeout(() => router.refresh(), 45000);
  }

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <button className="btn" onClick={run} disabled={busy}>
        Run audit now
      </button>
      <button className="btn secondary" onClick={() => router.refresh()}>
        Refresh
      </button>
      <span className="muted" style={{ margin: 0 }}>
        {msg}
      </span>
    </div>
  );
}
