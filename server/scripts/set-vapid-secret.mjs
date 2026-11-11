// One step: create a web-push (VAPID) key, hand it straight to Cloudflare as the Worker secret
// VAPID_PRIVATE_JWK, then ask the live Worker whether it accepted it.
// The key never touches the clipboard, a file or the screen. Run from anywhere:
//   node scripts/set-vapid-secret.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER = process.env.WORKER_URL ?? "https://feedback-to-pr.feedback-to-pr-server.workers.dev";

const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));

const put = spawnSync("npx", ["--no-install", "wrangler", "secret", "put", "VAPID_PRIVATE_JWK"], {
  input: jwk,
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: ["pipe", "inherit", "inherit"],
});
if (put.status !== 0) {
  console.error("\nCloudflare did not accept the secret. Nothing was saved. See the message above.");
  process.exit(put.status ?? 1);
}

// Give Cloudflare a few seconds to roll the new secret out, then verify from the outside.
let last = "no answer";
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const res = await fetch(`${WORKER}/v1/push/key`);
    const body = await res.json();
    if (res.ok && body.publicKey) {
      console.log(`\nDone. The server accepted the key (public key length ${body.publicKey.length}). Reload the Inbox page on your phone.`);
      process.exit(0);
    }
    last = body?.error?.message ?? `status ${res.status}`;
  } catch (e) {
    last = e instanceof Error ? e.message : String(e);
  }
}
console.error(`\nThe secret was uploaded, but the server still says: ${last}`);
process.exit(1);
