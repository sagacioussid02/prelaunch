/**
 * Prelaunch for Chrome — popup.
 *
 * Asks for access to the open site only when the user presses Scan
 * (optional host permissions, one site at a time), then hands the scan to
 * the service worker, which decides the tier from ExtensionPay. Every
 * string from a scan is rendered with textContent, never as HTML.
 */

import { originPatterns, scanTarget, toMarkdown, type ExtensionScanResult } from "./shared.ts";
import type { PlanStatus, Request } from "./background.ts";

const app = document.getElementById("app")!;
const siteEl = document.getElementById("site")!;
const accountBtn = document.getElementById("account") as HTMLButtonElement;

function send<T>(msg: Request): Promise<T> {
  return chrome.runtime.sendMessage(msg).then((res: { ok: boolean; value?: T; error?: string }) => {
    if (!res?.ok) throw new Error(res?.error ?? "The extension didn't answer. Reopen the popup.");
    return res.value as T;
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const c of children) node.append(c);
  return node;
}

function button(text: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = el("button", { className, text });
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function show(...nodes: Node[]): void {
  app.replaceChildren(...nodes);
}

let target = "";
let plan: PlanStatus = { paid: false, email: null };

function renderAccount(): void {
  accountBtn.hidden = false;
  if (plan.paid) {
    accountBtn.textContent = "Manage plan";
    accountBtn.onclick = () => void send({ type: "pay" });
  } else {
    accountBtn.textContent = "Already paid? Log in";
    accountBtn.onclick = () => void send({ type: "login" });
  }
}

function renderStart(note?: string): void {
  const nodes: Node[] = [
    el("p", {
      text: plan.paid
        ? "Run the full launch check on this site: secrets, security headers, SEO basics, 404 handling and error pages."
        : "Run a quick launch check on this site: exposed .env files, public source maps and missing security headers.",
    }),
  ];
  if (note) nodes.push(el("p", { className: "muted", text: note }));
  nodes.push(button("Scan this site", () => void startScan(), "primary"));
  show(...nodes);
}

async function startScan(): Promise<void> {
  // Called first thing in the click handler, with no await before it:
  // Chrome only shows the prompt during a user gesture. It resolves true
  // at once, with no prompt, when the site was already allowed.
  const origins = originPatterns(target);
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins });
  } catch {
    granted = false;
  }
  if (!granted) {
    renderStart("Prelaunch needs your OK to read this site before it can check it. Press Scan again and choose Allow.");
    return;
  }
  show(el("p", {}, [el("span", { className: "spinner" }), plan.paid ? "Running the full check…" : "Running the quick check…"]));
  try {
    const { result, plan: latest } = await send<{ result: ExtensionScanResult; plan: PlanStatus }>({ type: "scan", target });
    plan = latest;
    renderAccount();
    renderResult(result);
  } catch (err) {
    show(
      el("p", { className: "error", text: String((err as Error)?.message ?? err) }),
      button("Try again", () => void startScan()),
    );
  }
}

const OUTCOME_LABEL: Record<string, string> = {
  passed: "Passed",
  failed: "Couldn't finish",
  not_run: "Didn't run",
};

function renderResult(r: ExtensionScanResult): void {
  const nodes: Node[] = [];
  const chips = el("div", { className: "chips" }, [
    el("span", { className: "chip blocker", text: `${r.summary.blockers} blockers` }),
    el("span", { className: "chip warning", text: `${r.summary.warnings} warnings` }),
    el("span", { className: "chip info", text: `${r.summary.info} info` }),
  ]);
  const verdict = r.ready
    ? r.tier === "full"
      ? "Ready to launch"
      : "No blockers in the quick check"
    : r.summary.blockers
      ? "Fix the blockers before launch"
      : "Not ready yet";
  nodes.push(
    el("div", { className: "grade" }, [
      el("div", { className: "letter", text: r.grade }),
      el("div", {}, [
        el("div", { className: `verdict ${r.ready ? "ready" : "notready"}`, text: verdict }),
        el("div", { className: "muted", text: `${r.score}/100 · ${r.tier === "full" ? "full" : "quick"} check · ${r.checks.length} checks` }),
        chips,
      ]),
    ]),
  );

  if (plan.error) nodes.push(el("p", { className: "muted", text: plan.error }));

  nodes.push(el("h2", { text: "Checks" }));
  const list = el("ul", { className: "checks" });
  for (const c of r.checks) {
    const label = c.outcome === "issues" ? `${c.findings} found` : (OUTCOME_LABEL[c.outcome] ?? c.outcome);
    const cls = c.outcome === "issues" && c.worst === "blocker" ? "blocker" : c.outcome;
    const li = el("li", {}, [el("span", { text: c.name }), el("span", { className: `outcome ${cls}`, text: label })]);
    li.title = c.reason ? `${c.looksFor}\n\n${c.reason}` : c.looksFor;
    list.append(li);
  }
  for (const c of r.lockedChecks) {
    list.append(el("li", {}, [el("span", { text: c.name }), el("span", { className: "outcome locked", text: "Full report" })]));
  }
  nodes.push(list);

  if (r.tier === "full") {
    nodes.push(el("h2", { text: r.findings.length ? "Findings" : "Findings: none" }));
    for (const f of r.findings) {
      const card = el("div", { className: "finding" }, [
        el("div", { className: `sev ${f.severity}`, text: f.severity }),
        el("div", { className: "title", text: f.title }),
        el("code", { text: f.location }),
        el("div", { className: "fix", text: `Fix: ${f.fix}` }),
      ]);
      if (f.fixLink && /^https:\/\//.test(f.fixLink)) {
        const a = el("a", { text: "How to fix it" });
        a.href = f.fixLink;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        card.append(a);
      }
      nodes.push(card);
    }
    const copy = button("Copy as Markdown", () => {
      void navigator.clipboard.writeText(toMarkdown(r)).then(() => (copy.textContent = "Copied"));
    });
    const download = button("Download JSON", () => {
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `prelaunch-${new URL(r.url).host}-${r.checkedAt.slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    nodes.push(el("div", { className: "row" }, [copy, download, button("Scan again", () => void startScan())]));
  } else {
    const hidden = r.summary.blockers + r.summary.warnings + r.summary.info;
    nodes.push(
      el("div", { className: "locked-panel" }, [
        el("strong", {
          text: hidden ? `See all ${hidden} findings and how to fix them` : "Get the full launch report",
        }),
        el("p", {
          className: "muted",
          text: `The full report shows where each problem is and the fix, adds ${r.lockedChecks.length} more checks (${r.lockedChecks
            .map((c) => c.name)
            .join(", ")}), and exports to Markdown and JSON.`,
        }),
        button("Unlock the full report", () => void send({ type: "pay" }), "primary"),
      ]),
      el("div", { className: "row" }, [button("Scan again", () => void startScan())]),
    );
  }
  show(...nodes);
}

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    if (!tab?.url) throw new Error("Open a website (http or https) to scan it.");
    target = scanTarget(tab.url);
  } catch (err) {
    show(el("p", { text: String((err as Error)?.message ?? err) }));
    return;
  }
  siteEl.textContent = new URL(target).host;
  show(el("p", { className: "muted" }, [el("span", { className: "spinner" }), "Checking your plan…"]));
  plan = await send<PlanStatus>({ type: "plan" }).catch((err) => ({ paid: false, email: null, error: String(err?.message ?? err) }));
  renderAccount();
  const cached = await send<ExtensionScanResult | null>({ type: "cached", target }).catch(() => null);
  if (cached && (cached.tier === "full") === plan.paid) renderResult(cached);
  else renderStart();
}

void init();
