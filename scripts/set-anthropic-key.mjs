#!/usr/bin/env node
// Replace a repo's ANTHROPIC_API_KEY safely: type the key (hidden), it is TESTED against the API first,
// and only a working key is stored. Nothing is printed or saved if the key is bad.
//   node scripts/set-anthropic-key.mjs --repo owner/app [--model claude-sonnet-5-5]
import { spawnSync } from "node:child_process";
import { askHidden } from "./lib/ask-hidden.mjs";
import { checkAnthropicKey } from "./lib/check-anthropic.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : fallback; };
const repo = arg("--repo");
const model = arg("--model", "claude-sonnet-5-5");
if (!repo) { console.error("Usage: node scripts/set-anthropic-key.mjs --repo owner/app"); process.exit(2); }

const key = (await askHidden("Paste your Anthropic API key (nothing is shown): ")).trim();
if (!key.startsWith("sk-ant-")) { console.error("That does not look like an Anthropic key (it should start with sk-ant-). Nothing was saved."); process.exit(1); }

console.log("Testing the key with one tiny request...");
const result = await checkAnthropicKey({ key, model });
if (!result.ok) { console.error(`\n${result.reason}\nNothing was saved.`); process.exit(1); }

const put = spawnSync("gh", ["secret", "set", "ANTHROPIC_API_KEY", "-R", repo], { input: key, stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } });
if (put.status !== 0) { console.error("\nGitHub did not accept the secret. Nothing was saved."); process.exit(put.status ?? 1); }
console.log(`\nDone. A working key is stored for ${repo}. You can re-run the issue now.`);
