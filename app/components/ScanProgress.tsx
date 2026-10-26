"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Item {
  id: string;
  name: string;
  category: string;
  description: string;
  status: "pending" | "running" | "done";
  findingCount?: number;
  worst?: "blocker" | "warning" | "info";
  ms?: number;
}
interface Status {
  status: "running" | "done" | "failed";
  url: string;
  error?: string;
  progress: Item[];
}

const COLOR = { blocker: "#f87171", warning: "#fbbf24", info: "#60a5fa" } as const;

export default function ScanProgress({ id, url }: { id: string; url: string }) {
  const router = useRouter();
  const [s, setS] = useState<Status | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const r = await fetch(`/api/scan/${id}`, { cache: "no-store" });
        if (r.ok) {
          const data = (await r.json()) as Status;
          if (stop) return;
          setS(data);
          if (data.status === "done") {
            // Let the bar reach 100% before swapping to the report.
            setTimeout(() => router.refresh(), 700);
            return;
          }
          if (data.status === "failed") return;
        }
      } catch {
        /* retry */
      }
      timer = setTimeout(tick, 900);
    }
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, router]);

  const items = s?.progress ?? [];
  const done = items.filter((i) => i.status === "done").length;
  const pct = s?.status === "done" ? 100 : items.length ? Math.round((done / items.length) * 100) : 0;

  if (s?.status === "failed") {
    return (
      <main className="page">
        <p className="big">Scan failed</p>
        <p className="muted" style={{ textAlign: "center" }}>
          {s.error ?? "The scan could not complete."}
        </p>
        <p style={{ textAlign: "center" }}>
          <a href="/" className="btn" style={{ textDecoration: "none", display: "inline-block" }}>
            Try another URL
          </a>
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <p className="big rise">{pct === 100 ? "Building your report…" : "Auditing your site…"}</p>
      <p className="muted" style={{ textAlign: "center", wordBreak: "break-all" }}>
        {s?.url ?? url}
      </p>
      <div className="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="pct">
        <span>
          {done} of {items.length || "…"} checks complete
        </span>
        <span>{pct}%</span>
      </div>

      <div className="list" style={{ marginTop: 24 }}>
        {items.map((c, i) => (
          <div key={c.id} className={`item ${c.status} rise`} style={{ ["--i" as string]: i }}>
            <span
              className={`dot ${c.status}`}
              style={c.status === "done" ? { background: c.findingCount ? COLOR[c.worst ?? "info"] : "#4ade80" } : undefined}
            >
              {c.status === "done" ? (c.findingCount ? c.findingCount : "✓") : c.status === "pending" ? i + 1 : ""}
            </span>
            <div>
              <div className="t">{c.name}</div>
              <div className="d">
                {c.status === "done"
                  ? c.findingCount
                    ? `${c.findingCount} issue${c.findingCount > 1 ? "s" : ""} found · ${c.ms}ms`
                    : `All clear · ${c.ms}ms`
                  : c.description}
              </div>
            </div>
            <span className="cat">{c.status === "running" ? "checking…" : c.status === "pending" ? "queued" : c.category}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
