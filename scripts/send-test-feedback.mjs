#!/usr/bin/env node
// End-to-end check of the intake: sends one realistic message, waits for triage, and reports the outcome.
// It creates a REAL issue in the app's repo (labeled ai-triaged); GitHub then notifies you to approve it.
//   node scripts/send-test-feedback.mjs [--project medisync] [--worker https://...workers.dev]
const flag = (name, fallback) => { const k = process.argv.indexOf(name); return k > -1 ? process.argv[k + 1] : fallback; };
const project = flag("--project", "medisync");

const worker = flag("--worker", process.env.F2PR_WORKER ?? "https://feedback-to-pr.feedback-to-pr-server.workers.dev").replace(/\/+$/, "");

const res = await fetch(`${worker}/v1/feedback`, {
  method: "POST",
  headers: { "x-project": project, "content-type": "application/json", "idempotency-key": `setup-test-${Date.now()}` },
  body: JSON.stringify({
    message: "The snooze button on the Alarms screen is too small to tap reliably on my phone. (setup test)",
    context: { app_version: "setup-test", platform: "ios", screen: "Alarms" },
  }),
});
const body = await res.json();
if (res.status !== 202) { console.error(`\nNot accepted (${res.status}): ${body?.error?.message ?? "unknown error"}`); process.exit(1); }
console.log(`Accepted as ${body.id}. Waiting for triage...`);

let status = "received";
for (let n = 0; n < 20 && status === "received"; n++) {
  await new Promise((r) => setTimeout(r, 3000));
  const s = await fetch(`${worker}/v1/feedback/${body.id}`, { headers: { "x-project": project } });
  if (s.ok) status = (await s.json()).status;
}
const say = {
  triaged: "Done. It became a new issue labeled ai-triaged; GitHub will notify you. Add the label ai-fix to approve, or close the issue.",
  duplicate: "It matched an existing report, so a note was added there instead of a new issue.",
  rejected: "The triage model judged it not actionable, so no issue was made.",
  failed: "Triage failed. The reason is in the Worker logs (Cloudflare > Workers > feedback-to-pr > Observability).",
  received: "Still waiting after a minute. Check the Worker logs.",
};
console.log(`\nResult: ${status}. ${say[status] ?? ""}`);
process.exit(status === "triaged" || status === "duplicate" ? 0 : 1);
