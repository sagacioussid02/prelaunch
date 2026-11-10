import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy — PreLaunch Check",
  description: "What PreLaunch Check fetches, what it stores, and how site owners can opt out.",
};

/**
 * Privacy page (issue #7). The abuse/opt-out address below is a PLACEHOLDER:
 * the operator must replace <your-domain> with a real, monitored mailbox
 * before public launch.
 */
export default function PrivacyPage() {
  return (
    <main className="page">
      <h1 className="hero-title" style={{ fontSize: 34 }}>
        Privacy
      </h1>
      <p className="hero-sub" style={{ fontSize: 16 }}>
        What our scanner does, what we store, and how to reach us. Plain language on purpose.
      </p>

      <h2 className="section-title">What the scanner does</h2>
      <p className="muted">
        When someone submits a URL, our infrastructure fetches that site&rsquo;s public pages and
        subresources (HTML, scripts, headers, robots.txt, and similar) and, for full scans, loads
        the page in a real browser — the way any visitor&rsquo;s browser would. We never log in,
        submit forms, or use credentials. Our requests identify themselves with the{" "}
        <code>PreLaunchCheck/0.1</code> User-Agent, which links back to this page.
      </p>

      <h2 className="section-title">What we store</h2>
      <div className="list">
        <div className="item">
          <div>
            <div className="t">Scan reports</div>
            <div className="d">
              The submitted URL, the findings (for example: missing security headers, publicly
              reachable files, exposed keys), a score, and — for browser scans — screenshots of
              the target&rsquo;s public pages. Reports are viewable by anyone who has the report
              link; report pages are marked noindex so search engines don&rsquo;t list them.
            </div>
          </div>
        </div>
        <div className="item">
          <div>
            <div className="t">Monitors</div>
            <div className="d">
              If you enable monitoring we store the monitored URL, cadence, scan history, and the
              email address you give us for regression alerts. Deploy tokens are stored only as
              hashes.
            </div>
          </div>
        </div>
        <div className="item">
          <div>
            <div className="t">Waitlist</div>
            <div className="d">The email address you submit, kept until you ask us to delete it.</div>
          </div>
        </div>
        <div className="item">
          <div>
            <div className="t">Abuse-prevention log</div>
            <div className="d">
              For rate limiting and abuse handling we log a hashed form of the requester&rsquo;s IP
              address, the target host, and the time. We do not store raw IP addresses in this log.
            </div>
          </div>
        </div>
        <div className="item">
          <div>
            <div className="t">Billing</div>
            <div className="d">
              Paid plans are handled by Stripe. Card data goes to Stripe and never touches our
              servers; we store only the subscription status keyed to your email address.
            </div>
          </div>
        </div>
      </div>

      <h2 className="section-title">Retention</h2>
      <p className="muted">
        Anonymous scan reports are automatically deleted after 30 days. Monitor configuration and
        history are kept while the monitor exists; waitlist emails are kept until you ask for
        deletion. Ask, and we&rsquo;ll delete your data — contact below.
      </p>

      <h2 className="section-title">Cookies and tracking</h2>
      <p className="muted">
        We do not use advertising or cross-site tracking cookies, and we do not sell personal data.
      </p>

      <h2 className="section-title">Site owners: opt out / abuse</h2>
      <p className="muted">
        If you operate a site and want PreLaunch Check to stop scanning it, or you believe a scan
        was abusive, contact us and we will block the domain and remove stored reports for it:{" "}
        {/* OPERATOR: replace this placeholder with a monitored mailbox before launch. */}
        <code>abuse@&lt;your-domain&gt;</code>
      </p>

      <footer
        className="muted"
        style={{ marginTop: 48, paddingTop: 16, borderTop: "1px solid #22303f", fontSize: 13 }}
      >
        <a href="/">Home</a>
        {" · "}
        <a href="/terms">Terms</a>
        {" · "}
        <a href="/privacy">Privacy</a>
      </footer>
    </main>
  );
}
