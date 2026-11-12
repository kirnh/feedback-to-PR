#!/usr/bin/env node
// The one place to see and set every key.
//
//   node scripts/secrets.mjs list          what exists, where, what it is for, and what needs attention
//   node scripts/secrets.mjs setup         set everything that is missing and required, one at a time
//   node scripts/secrets.mjs set <ID>      set or replace one key (typed hidden, or generated; checked before it is stored)
//   node scripts/secrets.mjs doc           rewrite docs/SECRETS.md from secrets.manifest.json
//
// Keys live in GitHub secrets (the harness repo, plus each app repo for the ones an app needs).
// The deploy-worker workflow copies the Worker's keys from GitHub to Cloudflare. Values are never printed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { askHidden } from "./lib/ask-hidden.mjs";
import { runRecipe } from "./lib/recipes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400_000;

export const loadManifest = (root = ROOT) => JSON.parse(readFileSync(join(root, "secrets.manifest.json"), "utf8"));

// ---------------------------------------------------------------- inventory (pure)

/**
 * facts = { harness: [{name, updatedAt}], apps: { "owner/app": [{name, updatedAt}] }, worker: [names] | null }
 * Returns one row per key with a plain-words status.
 */
export function buildInventory(manifest, facts, nowMs) {
  const has = (list, name) => (list ?? []).find((x) => x.name === name);
  return manifest.secrets.map((s) => {
    const row = { id: s.id, label: s.label, scope: s.scope, required: !!s.required, what: s.what, usedBy: s.usedBy, derived: !!s.derivedFrom };
    let status = "set", note = "", updated = null;

    if (s.scope === "app") {
      const per = manifest.apps.map((app) => ({ app, found: has(facts.apps?.[app], s.id) }));
      const missing = per.filter((p) => !p.found).map((p) => p.app);
      if (missing.length) { status = "missing"; note = `not in ${missing.join(", ")}`; }
      updated = per.map((p) => p.found?.updatedAt).filter(Boolean).sort()[0] ?? null;
    } else {
      const inGithub = has(facts.harness, s.id);
      updated = inGithub?.updatedAt ?? null;
      if (s.scope === "worker") {
        const inWorker = facts.worker === null ? undefined : facts.worker.includes(s.workerName);
        if (inGithub && inWorker !== false) status = "set";
        else if (inGithub) { status = "waiting"; note = "stored in GitHub; the next deploy copies it to Cloudflare"; }
        else if (inWorker) { status = "legacy"; note = "only in Cloudflare; set it again here to manage it in one place"; }
        else status = "missing";
      } else status = inGithub ? "set" : "missing";
    }

    if (status === "set" && s.expiresInDays && updated) {
      const age = Math.floor((nowMs - Date.parse(updated)) / DAY);
      if (age >= s.expiresInDays) { status = "expired?"; note = `set ${age} days ago and meant to last ${s.expiresInDays}; renew it`; }
      else if (age >= s.expiresInDays - 2) { status = "expiring"; note = `set ${age} days ago and meant to last ${s.expiresInDays}`; }
    }
    return { ...row, status, note, updated };
  });
}

const LABEL = { set: "set", missing: "MISSING", waiting: "waiting", legacy: "legacy", expiring: "EXPIRING", "expired?": "EXPIRED?" };

export function renderInventory(rows) {
  const out = [];
  for (const [scope, title] of [["harness", "Deploy (GitHub secrets of the harness repo only)"], ["worker", "Cloudflare Worker (kept in GitHub, copied by the deploy job)"], ["app", "App repos (one copy per app)"]]) {
    out.push(title);
    for (const r of rows.filter((x) => x.scope === scope)) {
      out.push(`  ${LABEL[r.status].padEnd(9)} ${r.id}${r.required ? "" : "  (optional)"}${r.derived ? "  (copied automatically)" : ""}`);
      out.push(`            ${r.what}`);
      out.push(`            Used by: ${r.usedBy.join("; ")}`);
      if (r.note) out.push(`            >> ${r.note}`);
    }
    out.push("");
  }
  const need = rows.filter((r) => r.required && !r.derived && ["missing", "expired?", "legacy"].includes(r.status));
  out.push(need.length ? `${need.length} required key(s) need attention: ${need.map((r) => r.id).join(", ")}. Run: node scripts/secrets.mjs setup` : "All required keys are set.");
  return out.join("\n");
}

// ---------------------------------------------------------------- documentation (pure)

export function renderDoc(manifest) {
  const L = [
    "# Keys and secrets",
    "",
    "<!-- Generated from secrets.manifest.json by `node scripts/secrets.mjs doc`. Do not edit by hand; a test checks it is up to date. -->",
    "",
    "Every key lives in **GitHub secrets**. You set them all with one command, `node scripts/secrets.mjs set <ID>`, and see them all with `node scripts/secrets.mjs list`. A GitHub job (`deploy-worker`) copies the Worker's keys to Cloudflare, because the Worker cannot read GitHub secrets itself. Values are never shown, printed or written to a file.",
    "",
    `Harness repo: \`${manifest.harnessRepo}\`. Apps: ${manifest.apps.map((a) => `\`${a}\``).join(", ")}.`,
    "",
  ];
  const groups = [
    ["harness", "Deploy key", "Stored only as a GitHub secret of the harness repo."],
    ["worker", "Cloudflare Worker keys", "Stored as GitHub secrets of the harness repo, then copied to Cloudflare under the name shown in brackets."],
    ["app", "Keys each app repo needs", "Stored as secrets of each app repo. GitHub shows a repo's secrets only to that repo, so an app needs its own copy."],
  ];
  for (const [scope, title, intro] of groups) {
    L.push(`## ${title}`, "", intro, "");
    for (const s of manifest.secrets.filter((x) => x.scope === scope)) {
      L.push(`### \`${s.id}\`${s.workerName ? ` (Cloudflare: \`${s.workerName}\`)` : ""}${s.required ? "" : " (optional)"}`, "", s.what, "");
      L.push(`- **Used by:** ${s.usedBy.join("; ")}`);
      L.push(`- **How to get it:** ${s.howToGet}`);
      if (s.derivedFrom) L.push(`- **Set by:** \`${s.derivedFrom}\`, automatically`);
      else L.push(`- **Set it:** \`node scripts/secrets.mjs set ${s.id}\``);
      if (s.alsoSetInApps) L.push(`- **Also sets** \`${s.alsoSetInApps}\` in every app repo`);
      if (s.expiresInDays) L.push(`- **Expires:** meant to last ${s.expiresInDays} days; \`list\` warns before then`);
      L.push("");
    }
  }
  return L.join("\n");
}

// ---------------------------------------------------------------- side effects

function defaultSh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` }, ...opts });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function gatherFacts(manifest, sh, root = ROOT) {
  const ghList = (repo) => { const r = sh("gh", ["secret", "list", "-R", repo, "--json", "name,updatedAt"]); try { return r.code === 0 ? JSON.parse(r.stdout) : []; } catch { return []; } };
  const w = sh("npx", ["--no-install", "wrangler", "secret", "list"], { cwd: join(root, "server") });
  const m = /\[[\s\S]*\]/.exec(w.stdout);
  let worker = null;
  try { worker = w.code === 0 && m ? JSON.parse(m[0]).map((x) => x.name) : null; } catch { worker = null; }
  return { harness: ghList(manifest.harnessRepo), apps: Object.fromEntries(manifest.apps.map((a) => [a, ghList(a)])), worker };
}

/** Where a typed/generated value must be written. */
export function storesFor(manifest, entry) {
  const stores = [];
  if (entry.scope === "app") for (const app of manifest.apps) stores.push({ repo: app, name: entry.id });
  else stores.push({ repo: manifest.harnessRepo, name: entry.id });
  if (entry.alsoSetInApps) for (const app of manifest.apps) stores.push({ repo: app, name: entry.alsoSetInApps });
  return stores;
}

function readTomlSetting(root, name, fallback) {
  const p = join(root, "server/wrangler.toml");
  return existsSync(p) ? new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(readFileSync(p, "utf8"))?.[1] ?? fallback : fallback;
}

export async function setSecret(manifest, id, deps) {
  const { sh, ask, hashPassphrase, say, root = ROOT } = deps;
  const entry = manifest.secrets.find((s) => s.id === id);
  if (!entry) return { ok: false, message: `Unknown key '${id}'. Run 'list' to see the names.` };
  if (entry.derivedFrom) return { ok: false, message: `${id} is a copy. Set ${entry.derivedFrom} instead and it follows automatically.` };

  say(`\n${entry.label} (${id})\n  ${entry.what}\n  Used by: ${entry.usedBy.join("; ")}\n  How to get it: ${entry.howToGet}\n`);
  const ctx = { apps: manifest.apps, cloudflareAccountId: manifest.cloudflareAccountId, fetch: deps.fetch, triageProvider: readTomlSetting(root, "TRIAGE_PROVIDER", "anthropic"), triageModel: readTomlSetting(root, "TRIAGE_MODEL", "claude-haiku-5-5"), agentModel: "claude-sonnet-5-5" };
  const made = await runRecipe(entry.recipe, { ask, ctx, hashPassphrase });
  if (made.error) return { ok: false, message: made.error };

  const stored = [];
  for (const { repo, name } of storesFor(manifest, entry)) {
    const r = sh("gh", ["secret", "set", name, "-R", repo], { input: made.value });
    if (r.code !== 0) return { ok: false, message: `GitHub did not accept ${name} for ${repo}. Stored so far: ${stored.join(", ") || "nothing"}.` };
    stored.push(`${name} in ${repo}`);
  }

  if (entry.recipe.kind === "topic") {
    const copied = sh("pbcopy", [], { input: made.value }).code === 0;
    say(copied ? "The topic name is on your clipboard. In the ntfy app tap +, paste it, and subscribe. (Do not copy anything else first.)" : "Could not use the clipboard; the topic name was stored but not shown.");
  }
  return { ok: true, stored, needsDeploy: entry.scope === "worker" || entry.id === "CLOUDFLARE_API_TOKEN", message: `Stored: ${stored.join("; ")}.` };
}

async function deployAndWait(manifest, sh, say) {
  const have = (JSON.parse(sh("gh", ["secret", "list", "-R", manifest.harnessRepo, "--json", "name"]).stdout || "[]")).some((x) => x.name === "CLOUDFLARE_API_TOKEN");
  if (!have) { say("Saved in GitHub. It reaches Cloudflare after the deploy token is set: node scripts/secrets.mjs set CLOUDFLARE_API_TOKEN"); return true; }
  const started = Date.now();
  sh("gh", ["workflow", "run", "deploy-worker.yml", "-R", manifest.harnessRepo]);
  say("Copying to Cloudflare through GitHub (about a minute)...");
  let run = null;
  for (let i = 0; i < 20 && !run; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try { run = JSON.parse(sh("gh", ["run", "list", "-R", manifest.harnessRepo, "--workflow", "deploy-worker.yml", "--limit", "1", "--json", "databaseId,createdAt"]).stdout)[0]; } catch { /* retry */ }
    if (run && Date.parse(run.createdAt) < started - 5000) run = null;
  }
  if (!run) { say("The deploy job did not start. Open the Actions tab of the harness repo."); return false; }
  const watched = sh("gh", ["run", "watch", String(run.databaseId), "-R", manifest.harnessRepo, "--exit-status"]);
  say(watched.code === 0 ? "Done. Cloudflare has the new key." : `The deploy job failed: gh run view ${run.databaseId} -R ${manifest.harnessRepo} --log-failed`);
  return watched.code === 0;
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  const manifest = loadManifest();
  const sh = defaultSh;
  const say = (m) => console.log(m);
  const hashPassphrase = async (p) => (await import("../server/scripts/lib/passphrase-hash.mjs")).storedPassphrase(p);

  if (cmd === "list") {
    const rows = buildInventory(manifest, gatherFacts(manifest, sh), Date.now());
    console.log(process.argv.includes("--json") ? JSON.stringify(rows, null, 2) : renderInventory(rows));
  } else if (cmd === "doc") {
    writeFileSync(join(ROOT, "docs/SECRETS.md"), renderDoc(manifest));
    console.log("Wrote docs/SECRETS.md");
  } else if (cmd === "set" && arg) {
    const r = await setSecret(manifest, arg, { sh, ask: askHidden, hashPassphrase, say });
    console.log(r.message);
    if (!r.ok) process.exit(1);
    if (r.needsDeploy && !(await deployAndWait(manifest, sh, say))) process.exit(1);
  } else if (cmd === "setup") {
    const all = buildInventory(manifest, gatherFacts(manifest, sh), Date.now()).filter((r) => !r.derived && ["missing", "expired?", "legacy"].includes(r.status));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let changed = false;
    for (const r of all) {
      if (!r.required && !/^y/i.test(await rl.question(`\nOptional: ${r.label}. ${r.what}\nSet it now? (y/N) `))) continue;
      const res = await setSecret(manifest, r.id, { sh, ask: askHidden, hashPassphrase, say });
      console.log(res.message);
      if (!res.ok) { rl.close(); process.exit(1); }
      changed = true;
    }
    rl.close();
    if (!all.length) console.log("Every key is set. Run 'list' to see everything.");
    else if (changed) { await deployAndWait(manifest, sh, say); console.log("\nDone. Run 'node scripts/secrets.mjs list' to check."); }
  } else {
    console.error("Usage: node scripts/secrets.mjs list | setup | set <ID> | doc");
    process.exit(2);
  }
}
