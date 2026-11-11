#!/usr/bin/env node
// End-to-end check of the intake: sends one realistic message with a beta code, waits for triage, and reports the outcome.
// It creates a REAL issue in the app's repo (labeled ai-triaged), which also sends the approval request to your phone.
//   node scripts/send-test-feedback.mjs [--worker https://...workers.dev]
import { askHidden } from "./lib/ask-hidden.mjs";

const i = process.argv.indexOf("--worker");
const worker = (i > -1 ? process.argv[i + 1] : process.env.F2PR_WORKER ?? "https://feedback-to-pr.feedback-to-pr-server.workers.dev").replace(/\/+$/, "");

const code = (await askHidden("Paste the beta code (nothing is shown): ")).trim();
const res = await fetch(`${worker}/v1/feedback`, {
  method: "POST",
  headers: { authorization: `Bearer ${code}`, "content-type": "application/json", "idempotency-key": `setup-test-${Date.now()}` },
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
  const s = await fetch(`${worker}/v1/feedback/${body.id}`, { headers: { authorization: `Bearer ${code}` } });
  if (s.ok) status = (await s.json()).status;
}
const say = {
  triaged: "Done. It became a new issue labeled ai-triaged; your phone should show 'Approve fix?'. Close the test issue on GitHub when you are finished.",
  duplicate: "It matched an existing report, so a note was added there instead of a new issue.",
  rejected: "The triage model judged it not actionable, so no issue was made.",
  failed: "Triage failed. The reason is on the dashboard under Problems.",
  received: "Still waiting after a minute. Check the dashboard under Problems.",
};
console.log(`\nResult: ${status}. ${say[status] ?? ""}`);
process.exit(status === "triaged" || status === "duplicate" ? 0 : 1);
