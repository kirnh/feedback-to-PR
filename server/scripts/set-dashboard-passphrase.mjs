// Choose the dashboard passphrase. You type it twice (hidden). Only a salted hash is stored, as the Worker
// secret DASHBOARD_PASS. The script then signs in against the live Worker to prove it works.
//   node scripts/set-dashboard-passphrase.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { storedPassphrase } from "./lib/passphrase-hash.mjs";

const WORKER = process.env.WORKER_URL ?? "https://feedback-to-pr.feedback-to-pr-server.workers.dev";

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("This needs an interactive terminal so the passphrase stays hidden."));
    process.stdout.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stdout.write("\n"); return resolve(buf); }
        if (ch === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1); else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const first = await askHidden("Choose a passphrase (at least 10 characters, nothing is shown): ");
if (first.length < 10) { console.error("Too short. Use at least 10 characters, e.g. four random words."); process.exit(1); }
const second = await askHidden("Type it again: ");
if (first !== second) { console.error("They did not match. Nothing was saved."); process.exit(1); }

const put = spawnSync("npx", ["--no-install", "wrangler", "secret", "put", "DASHBOARD_PASS"], {
  input: await storedPassphrase(first),
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: ["pipe", "inherit", "inherit"],
});
if (put.status !== 0) { console.error("\nCloudflare did not accept the secret. Nothing was saved. See the message above."); process.exit(put.status ?? 1); }

let last = "no answer";
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const res = await fetch(`${WORKER}/v1/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: first }) });
    if (res.ok) { console.log(`\nDone. Sign-in works. Open ${WORKER}/app/ and use your passphrase.`); process.exit(0); }
    last = (await res.json())?.error?.message ?? `status ${res.status}`;
  } catch (e) { last = e instanceof Error ? e.message : String(e); }
}
console.error(`\nThe secret was uploaded, but a test sign-in failed: ${last}`);
process.exit(1);
