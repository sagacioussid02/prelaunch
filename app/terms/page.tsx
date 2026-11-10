import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms — PreLaunch Check",
  description: "The rules for using PreLaunch Check: scan only what you own or have permission to test.",
};

/**
 * Terms page (issue #7). The abuse contact below is a PLACEHOLDER: the
 * operator must replace <your-domain> with a real, monitored mailbox
 * before public launch.
 */
export default function TermsPage() {
  return (
    <main className="page">
      <h1 className="hero-title" style={{ fontSize: 34 }}>
        Terms of use
      </h1>
      <p className="hero-sub" style={{ fontSize: 16 }}>
        Short version: scan your own sites, don&rsquo;t abuse the service, and treat the report as
        a helpful second pair of eyes — not a guarantee.
      </p>

      <h2 className="section-title">Only scan what you&rsquo;re allowed to</h2>
      <p className="muted">
        Only submit sites you own or have explicit permission to test. By submitting a URL you
        state that you have that right, and you are responsible for your scans. Scanning a
        third-party site can itself be against that site&rsquo;s terms or the law in your
        jurisdiction — that risk is yours, not ours.
      </p>

      <h2 className="section-title">Acceptable use</h2>
      <p className="muted">
        Don&rsquo;t use the service to facilitate wrongdoing, to probe sites as a prelude to
        attacking them, or to overload the service or any target. We enforce rate limits and may
        block abusive requesters or targets at our discretion. Site owners can opt their domains
        out — see <a href="/privacy">Privacy</a>.
      </p>

      <h2 className="section-title">Reports are shareable</h2>
      <p className="muted">
        Every scan produces a report page reachable by anyone with its link (report pages are
        marked noindex for search engines, but the link itself is the key). Don&rsquo;t scan a site
        whose findings you wouldn&rsquo;t want described to anyone holding that link.
      </p>

      <h2 className="section-title">No warranty</h2>
      <p className="muted">
        The service is provided &ldquo;as is&rdquo;, without warranty of any kind. Checks are
        automated and incomplete: a clean report does not mean a site is secure, and a finding can
        be a false positive. Verify anything important with your own testing before you rely on
        it. To the extent the law allows, we are not liable for damages arising from use of the
        service or its reports.
      </p>

      <h2 className="section-title">Abuse contact</h2>
      <p className="muted">
        Reports of abuse, and opt-out requests from site owners:{" "}
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
