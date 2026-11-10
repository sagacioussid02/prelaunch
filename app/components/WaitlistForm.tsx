"use client";

import { useState } from "react";

/**
 * Early-access signup for continuous monitoring (Phase 0 step 3).
 * Posts to /api/waitlist with source "landing".
 *
 * Copy is deliberately plain: one-off audits are the free product;
 * continuous monitoring already exists for self-serve monitors and is
 * rolling out more widely from this list. No launch email is promised —
 * the API only captures the address, it sends nothing.
 */
export default function WaitlistForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [joined, setJoined] = useState<"created" | "already" | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    const res = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: fd.get("email"), source: "landing" }),
    }).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) {
      setError(res ? await res.text() : "Could not reach the server.");
      return;
    }
    const data = (await res.json()) as { already?: boolean };
    setJoined(data.already ? "already" : "created");
  }

  if (joined) {
    return (
      <div className="panel">
        <h3>{joined === "already" ? "Already on the list" : "You’re on the list"}</h3>
        <p className="muted">
          {joined === "already"
            ? "That email is already signed up for early access to continuous monitoring."
            : "Early access to continuous monitoring opens in signup order."}
        </p>
      </div>
    );
  }

  return (
    <form className="panel" onSubmit={onSubmit}>
      <h3>Continuous monitoring — early access</h3>
      <p className="muted">
        The audit above is one-off. Continuous monitoring re-audits your site on a schedule and flags new
        blockers as they appear. It&rsquo;s rolling out gradually — join the list for early access.
      </p>
      <label>Email for early access</label>
      <input type="email" name="email" required placeholder="you@example.com" autoComplete="email" />
      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Joining…" : "Join the waitlist"}
      </button>
      <p className="err">{error}</p>
    </form>
  );
}
