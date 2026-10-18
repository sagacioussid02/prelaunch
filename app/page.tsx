/** Landing page: URL input → scan. Mobile-first, one job. */
export default function Home() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "72px 20px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: 40, margin: "0 0 8px" }}>PreLaunch Check</h1>
      <p style={{ color: "#475569", fontSize: 18, marginTop: 0 }}>
        One-click pre-launch audit for your app. Paste a URL, get a graded,
        shareable report.
      </p>

      <form id="scan-form" style={{ marginTop: 32, display: "flex", gap: 8 }}>
        <input
          name="url"
          type="url"
          required
          placeholder="https://your-app.vercel.app"
          style={{
            flex: 1,
            padding: "14px 16px",
            fontSize: 16,
            borderRadius: 10,
            border: "1px solid #cbd5e1",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "14px 24px",
            fontSize: 16,
            fontWeight: 700,
            borderRadius: 10,
            border: "none",
            background: "#0f172a",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Audit
        </button>
      </form>
      <p id="status" style={{ color: "#64748b", minHeight: 24 }} />

      <ul
        style={{
          textAlign: "left",
          color: "#334155",
          marginTop: 40,
          lineHeight: 1.9,
          paddingLeft: 20,
        }}
      >
        <li>🔑 Leaked env vars & secrets in your JS bundle</li>
        <li>🛡 Missing security headers & HTTPS gaps</li>
        <li>🔍 SEO & launch basics (title, OG tags, sitemap…)</li>
        <li>📄 Shareable graded report + README badge</li>
      </ul>

      <script
        dangerouslySetInnerHTML={{
          __html: `
          document.getElementById('scan-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const url = new FormData(e.target).get('url');
            const status = document.getElementById('status');
            status.textContent = 'Scanning… this takes ~15–30s.';
            const res = await fetch('/api/scan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url }),
            });
            if (!res.ok) { status.textContent = 'Scan failed: ' + (await res.text()); return; }
            const { id } = await res.json();
            window.location.href = '/r/' + id;
          });`,
        }}
      />
    </main>
  );
}
