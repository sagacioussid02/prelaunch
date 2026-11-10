"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Dashboard "Run audit now". Issue #6: a manual run needs proof of
 * ownership. With a signed dashboard grant (from the link returned when the
 * monitor was created, valid for an hour) it runs directly; otherwise the
 * owner pastes the monitor's deploy token, which is sent as a header and
 * never stored.
 */
export default function RunNow({ id, running, grant }: { id: string; running: boolean; grant?: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState(running ? "An audit is running…" : "");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");

  async function run() {
    setBusy(true);
    const qs = new URLSearchParams({ manual: "1" });
    if (grant) qs.set("grant", grant);
    const headers: Record<string, string> = {};
    if (!grant && token.trim()) headers["x-prelaunch-token"] = token.trim();
    const res = await fetch(`/api/monitor/${id}/deploy?${qs}`, { method: "POST", headers }).catch(() => null);
    if (res?.status === 202) setMsg("Audit started. Refresh in about a minute.");
    else if (res?.status === 401)
      setMsg(grant ? "This link has expired. Paste your deploy token instead." : "That deploy token isn't valid for this monitor.");
    else setMsg(res ? await res.text() : "Request failed.");
    setBusy(false);
    if (res?.status === 202) setTimeout(() => router.refresh(), 45000);
  }

  const needsToken = !grant;
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      {needsToken && (
        <input
          type="password"
          autoComplete="off"
          placeholder="Deploy token"
          aria-label="Deploy token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ minWidth: 220 }}
        />
      )}
      <button className="btn" onClick={run} disabled={busy || (needsToken && !token.trim())}>
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
