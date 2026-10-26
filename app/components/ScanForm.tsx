"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ScanForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get("url") ?? "").trim();
    if (!url) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setError(res ? await res.text() : "Could not reach the server.");
      setBusy(false);
      return;
    }
    const { id } = (await res.json()) as { id: string };
    router.push(`/r/${id}`);
  }

  return (
    <>
      <form className="scan-form" onSubmit={onSubmit}>
        <input name="url" type="text" required placeholder="https://your-app.vercel.app" autoComplete="off" />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Starting…" : "Audit"}
        </button>
      </form>
      <p className="err">{error}</p>
    </>
  );
}
