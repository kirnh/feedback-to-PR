// Create a VAPID key pair for web push and put the PRIVATE key (as JWK JSON) on the clipboard.
// Nothing secret is printed. Then store it with:  npx wrangler secret put VAPID_PRIVATE_JWK
// The public key is derived from the private one by the Worker, so there is nothing else to copy.
import { spawnSync } from "node:child_process";

const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));

const copied = spawnSync("pbcopy", { input: jwk });
if (copied.status !== 0) {
  console.error("Could not use the clipboard (pbcopy is macOS only). Nothing was printed or saved.");
  process.exit(1);
}
console.log("New VAPID private key copied to the clipboard (not shown).");
console.log("Next: npx wrangler secret put VAPID_PRIVATE_JWK   then paste when asked.");
