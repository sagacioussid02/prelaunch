"use client";

import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import MonitorCta from "./MonitorCta";

// Memoized: a parent re-render must not re-apply innerHTML, or the portal slot and tilt targets get replaced.
const StaticHtml = memo(function StaticHtml({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Renders the server-built report HTML and layers on counters, 3D tilt and the monitoring form. */
export default function ReportShell({ html, url }: { html: string; url: string }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById("monitor-slot"));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Count-up for the score.
    document.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
      const target = Number(el.dataset.count);
      const start = performance.now();
      const step = (t: number) => {
        const p = Math.min(1, (t - start) / 1300);
        el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    // Pointer-driven 3D tilt on the hero and check cards.
    const cleanups: Array<() => void> = [];
    document.querySelectorAll<HTMLElement>("[data-tilt], .pl-tilt").forEach((el) => {
      const max = el.hasAttribute("data-tilt") ? 6 : 5;
      const move = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        el.style.setProperty("--ry", `${x * max * 2}deg`);
        el.style.setProperty("--rx", `${-y * max * 2}deg`);
      };
      const leave = () => {
        el.style.setProperty("--rx", "0deg");
        el.style.setProperty("--ry", "0deg");
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerleave", leave);
      cleanups.push(() => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerleave", leave);
      });
    });
    return () => cleanups.forEach((c) => c());
  }, [html]);

  return (
    <>
      <StaticHtml html={html} />
      {slot ? createPortal(<MonitorCta url={url} />, slot) : null}
    </>
  );
}
