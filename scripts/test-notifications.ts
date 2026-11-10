/**
 * Monitoring v2 notification checks (Phase 0 step 4): regression
 * detection, the email decision matrix (regression-only, per-incident
 * hash dedupe, recovery clearing), email rendering, and the recorded
 * delivery path — Resend stubbed, never real network.
 *
 * Self-contained: isolates PRELAUNCH_DATA_DIR to a temp dir before
 * importing the lib modules (the store reads it at module load).
 * Run: node scripts/test-notifications.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRELAUNCH_DATA_DIR = mkdtempSync(join(tmpdir(), "pl-notify-"));
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.RESEND_API_KEY;
delete process.env.NOTIFY_FROM;

const {
  computeRegression,
  decideEmailNotification,
  regressionHashFor,
  renderMonitorEmail,
  notifyRegression,
  listNotifications,
} = await import("../lib/notify.ts");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

const blocker = {
  checkId: "secrets",
  title: "Exposed API key",
  location: "https://example.com/app.js",
  fix: "Rotate it",
};
const blocker2 = {
  checkId: "headers",
  title: "Missing Content-Security-Policy",
  location: "https://example.com",
  fix: "Add the header",
};

// --- regression detection ---
check("regression: new blocker", computeRegression({ prevScore: 95, nextScore: 94, newBlockers: [blocker] }));
check("regression: drop of exactly 10", computeRegression({ prevScore: 90, nextScore: 80, newBlockers: [] }));
check("no regression: drop of 9", !computeRegression({ prevScore: 90, nextScore: 81, newBlockers: [] }));
check("no regression: improvement", !computeRegression({ prevScore: 80, nextScore: 95, newBlockers: [] }));
check("no regression: baseline (no prev)", !computeRegression({ prevScore: null, nextScore: 40, newBlockers: [] }));

// --- regression hash: stable identity of an incident ---
{
  const h1 = regressionHashFor({ newBlockers: [blocker, blocker2], prevScore: 95, nextScore: 80 });
  const h2 = regressionHashFor({ newBlockers: [blocker2, blocker], prevScore: 95, nextScore: 80 });
  check("hash: order-insensitive", h1 === h2);
  const h3 = regressionHashFor({ newBlockers: [blocker], prevScore: 95, nextScore: 80 });
  check("hash: changes with the set", h1 !== h3);
  const s1 = regressionHashFor({ newBlockers: [], prevScore: 95, nextScore: 80 });
  const s2 = regressionHashFor({ newBlockers: [], prevScore: 95, nextScore: 70 });
  check("hash: score-drop regression keyed by score pair", s1 !== s2 && s1 !== h3);
}

// --- decision matrix ---
const base = {
  email: "owner@example.com",
  regressionOnly: true,
  isBaseline: false,
  regression: true,
  hash: "hash-a",
  lastNotifiedHash: null,
};
check("decide: regression + email + new incident sends", decideEmailNotification(base).action === "send");
{
  const d = decideEmailNotification({ ...base, lastNotifiedHash: "hash-a" });
  check("decide: same incident is deduped", d.action === "skip" && d.reason === "duplicate" && !d.clearHash);
}
{
  const d = decideEmailNotification({ ...base, regression: false, hash: "hash-b" });
  check("decide: healthy run silent + clears incident", d.action === "skip" && d.reason === "not-regression" && d.clearHash);
  // After the clear, the SAME regression hash must notify again.
  const again = decideEmailNotification({ ...base, lastNotifiedHash: null });
  check("decide: same regression after recovery sends again", again.action === "send");
}
{
  const d = decideEmailNotification({ ...base, email: null });
  check("decide: no email silent", d.action === "skip" && d.reason === "no-email");
  const b = decideEmailNotification({ ...base, isBaseline: true });
  check("decide: baseline silent", b.action === "skip" && b.reason === "baseline");
  const every = decideEmailNotification({ ...base, regressionOnly: false, regression: false, hash: "hash-c" });
  check("decide: regressionOnly off emails non-regression runs", every.action === "send");
}

// --- rendering ---
{
  const { subject, body } = renderMonitorEmail({
    monitorUrl: "https://example.com",
    info: {
      newBlockers: [blocker],
      prevScore: 95,
      nextScore: 80,
      prevGrade: "A+",
      nextGrade: "B",
      newFindingsCount: 1,
      resolvedCount: 0,
    },
    reportUrl: "https://app.example/r/scan-1",
  });
  check(
    "email render: subject scores + body blocker/fix/report",
    subject.includes("95 → 80") && body.includes("Exposed API key") &&
      body.includes("Rotate it") && body.includes("https://app.example/r/scan-1"),
  );
}

// --- recorded delivery (file backend; Resend stubbed) ---
const info = {
  newBlockers: [blocker],
  prevScore: 95,
  nextScore: 80,
  prevGrade: "A+",
  nextGrade: "B",
  newFindingsCount: 1,
  resolvedCount: 0,
};
{
  const none = await notifyRegression({
    monitorId: "m1", monitorUrl: "https://example.com", email: "owner@example.com",
    regressionOnly: true, regression: false, info, scanId: "s0",
    reportUrl: "https://app.example/r/s0",
  });
  check("notify: non-regression records nothing", none === null && (await listNotifications()).length === 0);

  const queued = await notifyRegression({
    monitorId: "m1", monitorUrl: "https://example.com", email: "owner@example.com",
    regressionOnly: true, regression: true, info, scanId: "s1",
    reportUrl: "https://app.example/r/s1",
  });
  check("notify: unconfigured provider records queued", queued?.status === "queued" && queued.email === "owner@example.com");
  check("notify: record persisted", (await listNotifications()).length === 1);

  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "test-key";
  process.env.NOTIFY_FROM = "alerts@example.com";
  try {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    const failed = await notifyRegression({
      monitorId: "m1", monitorUrl: "https://example.com", email: "owner@example.com",
      regressionOnly: true, regression: true, info, scanId: "s2",
      reportUrl: "https://app.example/r/s2",
    });
    check("notify: provider failure recorded, not thrown", failed?.status === "failed" && !!failed.error);

    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as typeof fetch;
    const sent = await notifyRegression({
      monitorId: "m1", monitorUrl: "https://example.com", email: "owner@example.com",
      regressionOnly: true, regression: true, info, scanId: "s3",
      reportUrl: "https://app.example/r/s3",
    });
    check("notify: provider success records sent", sent?.status === "sent");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFY_FROM;
  }
}

if (failures > 0) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log("ALL PASS (test-notifications)");
