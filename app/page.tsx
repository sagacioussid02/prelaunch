import { initialProgress } from "@/lib/scanner";
import ScanForm from "./components/ScanForm";

export default function Home() {
  const checks = initialProgress("passive");
  return (
    <main className="page">
      <h1 className="hero-title rise">PreLaunch Check</h1>
      <p className="hero-sub rise" style={{ ["--i" as string]: 1 }}>
        Paste a URL. We audit the live site with real HTTP checks and a real browser, then hand you a graded report.
      </p>
      <ScanForm />

      <h2 className="section-title">What we&rsquo;ll look for</h2>
      <p className="muted">
        {checks.length} checks run in parallel. You&rsquo;ll watch each one complete, then get a report that explains every finding.
      </p>
      <div className="list">
        {checks.map((c, i) => (
          <div key={c.id} className="item rise" style={{ ["--i" as string]: i }}>
            <span className="dot">{i + 1}</span>
            <div>
              <div className="t">{c.name}</div>
              <div className="d">{c.description}</div>
            </div>
            <span className="cat">{c.category}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
