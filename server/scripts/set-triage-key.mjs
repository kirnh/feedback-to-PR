// Store the API key the intake uses to rewrite feedback into issues (Worker secret TRIAGE_LLM_KEY).
// You type it hidden; for Anthropic it is TESTED against the API first and only stored if it works.
//   node scripts/set-triage-key.mjs
// The model and provider are plain settings in wrangler.toml (TRIAGE_PROVIDER, TRIAGE_MODEL, TRIAGE_BASE_URL).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { askHidden } from "../../scripts/lib/ask-hidden.mjs";
import { checkAnthropicKey } from "../../scripts/lib/check-anthropic.mjs";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const toml = readFileSync(`${serverDir}wrangler.toml`, "utf8");
const setting = (name, fallback) => new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1] ?? fallback;
const provider = setting("TRIAGE_PROVIDER", "anthropic");
const model = setting("TRIAGE_MODEL", "claude-haiku-5-5");

const key = (await askHidden(`Paste the API key for triage (${provider}, model ${model}; nothing is shown): `)).trim();
if (key.length < 20) { console.error("That looks too short to be a key. Nothing was saved."); process.exit(1); }

if (provider === "anthropic") {
  console.log("Testing the key with one tiny request...");
  const r = await checkAnthropicKey({ key, model });
  if (!r.ok) { console.error(`\n${r.reason}\nNothing was saved.`); process.exit(1); }
} else {
  console.log(`Provider is ${provider}; the key cannot be tested here and will be stored as given.`);
}

const put = spawnSync("npx", ["--no-install", "wrangler", "secret", "put", "TRIAGE_LLM_KEY"], { input: key, cwd: serverDir, stdio: ["pipe", "inherit", "inherit"] });
if (put.status !== 0) { console.error("\nCloudflare did not accept the secret. Nothing was saved."); process.exit(put.status ?? 1); }
console.log("\nDone. Triage can now rewrite feedback. Next: make a beta code on the dashboard, then run scripts/send-test-feedback.mjs.");
