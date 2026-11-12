#!/usr/bin/env node
// Runs inside the deploy workflow: copy the harness repo's GitHub secrets to the Cloudflare Worker.
// Safety rules: a key is copied only if it exists and is not empty (so a missing key can never blank a working one),
// and only key NAMES are ever printed.
//   env: ALL_SECRETS  JSON of the repo's secrets (from ${{ toJSON(secrets) }}), CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** What would be copied, and what would be skipped. Pure. */
export function planSync(manifest, allSecrets) {
  const push = [], skip = [];
  for (const s of manifest.secrets.filter((x) => x.scope === "worker")) {
    const value = allSecrets[s.id];
    (typeof value === "string" && value !== "" ? push : skip).push({ github: s.id, worker: s.workerName });
  }
  return { push, skip };
}

export async function syncSecrets({ manifest, allSecrets, put }) {
  const { push, skip } = planSync(manifest, allSecrets);
  const failed = [];
  for (const p of push) {
    const ok = await put(p.worker, allSecrets[p.github]);
    (ok ? [] : failed).push(p.worker);
  }
  return { pushed: push.map((p) => p.worker).filter((n) => !failed.includes(n)), skipped: skip.map((s) => s.worker), failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "secrets.manifest.json"), "utf8"));
  let allSecrets;
  try { allSecrets = JSON.parse(process.env.ALL_SECRETS ?? "{}"); } catch { console.error("ALL_SECRETS is not valid JSON."); process.exit(1); }

  const put = (name, value) => spawnSync("npx", ["--no-install", "wrangler", "secret", "put", name], { input: value, cwd: join(root, "server"), stdio: ["pipe", "ignore", "inherit"] }).status === 0;
  const r = await syncSecrets({ manifest, allSecrets, put });
  if (r.pushed.length) console.log(`Copied to Cloudflare: ${r.pushed.join(", ")}`);
  if (r.skipped.length) console.log(`Not set in GitHub, left unchanged in Cloudflare: ${r.skipped.join(", ")}`);
  if (r.failed.length) { console.error(`Cloudflare refused: ${r.failed.join(", ")}`); process.exit(1); }
}
