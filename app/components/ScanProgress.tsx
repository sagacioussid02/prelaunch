"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Item {
  id: string;
  name: string;
  category: string;
  description: string;
  status: "pending" | "running" | "done";
  outcome?: "passed" | "issues" | "failed" | "not_run";
  reason?: string;
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

type Outcome = NonNullable<Item["outcome"]>;
/** Same derivation as checkOutcome() in lib/checks/types.ts (kept client-side). */
function outcomeOf(c: Item): Outcome | undefined {
  if (c.status !== "done") return undefined;
  return c.outcome ?? (c.findingCount ? "issues" : "passed");
}

function dot(c: Item, i: number): { bg?: string; text: string } {
  const o = outcomeOf(c);
  if (!o) return { text: c.status === "pending" ? String(i + 1) : "" };
  if (o === "issues") return { bg: COLOR[c.worst ?? "info"], text: String(c.findingCount ?? "") };
  if (o === "failed") return { bg: "#f87171", text: "✕" };
  if (o === "not_run") return { bg: "#64748b", text: "–" };
  return { bg: "#4ade80", text: "✓" };
}

function detail(c: Item): string {
  const o = outcomeOf(c);
  if (!o) return c.description;
  if (o === "issues") return `${c.findingCount} issue${(c.findingCount ?? 0) > 1 ? "s" : ""} found · ${c.ms}ms`;
  if (o === "failed") return `Failed: ${c.reason ?? "the check errored"}`;
  if (o === "not_run") return `Didn't run: ${c.reason ?? "not available for this scan"}`;
  return `Passed · ${c.ms}ms`;
}

const TAG: Record<Outcome, string> = { passed: "passed", issues: "issues", failed: "failed", not_run: "didn't run" };

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
  const counts = (o: Outcome) => items.filter((c) => outcomeOf(c) === o).length;
  const summary = (
    [
      [counts("passed"), "passed"],
      [counts("issues"), "with issues"],
      [counts("failed"), "failed"],
      [counts("not_run"), "didn't run"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, l]) => `${n} ${l}`)
    .join(", ");

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
          {summary ? ` · ${summary}` : ""}
        </span>
        <span>{pct}%</span>
      </div>

      <div className="list" style={{ marginTop: 24 }}>
        {items.map((c, i) => {
          const d = dot(c, i);
          const o = outcomeOf(c);
          return (
            <div key={c.id} className={`item ${c.status} ${o ?? ""} rise`} style={{ ["--i" as string]: i }}>
              <span className={`dot ${c.status}`} style={d.bg ? { background: d.bg } : undefined}>
                {d.text}
              </span>
              <div>
                <div className="t">{c.name}</div>
                <div className="d">{detail(c)}</div>
              </div>
              <span className="cat">{c.status === "running" ? "checking…" : c.status === "pending" ? "queued" : o ? TAG[o] : c.category}</span>
            </div>
          );
        })}
      </div>
    </main>
  );
}
