#!/usr/bin/env node
// doctor: check every link of the setup for one app repo and print the exact fix for anything wrong.
//
//   node scripts/doctor.mjs --repo owner/app --worker https://your-worker.workers.dev [--remote]
//
// Needs the GitHub CLI (`gh`, logged in) and, for the Worker checks, Node with `npx wrangler` logged in.
// --remote also runs a small workflow in the app repo that tests the repo's own ANTHROPIC_API_KEY (one 1-token request).
// Reads only: it never changes anything and never prints a secret value (it cannot read them).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Default command runner. Returns instead of throwing so each check can explain a failure. */
export function realSh(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` }, ...opts });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message ?? "") };
  }
}

export async function realFetchJson(url, init) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), ...init });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const pass = (title, detail) => ({ level: "pass", title, detail });
const warn = (title, detail, fix) => ({ level: "warn", title, detail, fix });
const fail = (title, detail, fix) => ({ level: "fail", title, detail, fix });

const names = (text) => {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[0]).map((x) => x.name); } catch { return null; }
};

/**
 * Run every check. `deps` = { sh, fetchJson, readFile, fileExists, harnessDir }.
 * Returns a flat list of { level: pass|warn|fail, title, detail?, fix? }.
 */
export async function runDoctor({ repo, worker, remote = false }, deps) {
  const { sh, fetchJson, readFile, fileExists, harnessDir, manifest } = deps;
  const out = [];
  const gh = (...args) => sh("gh", args);
  const ghJson = (...args) => { const r = gh(...args); if (r.code !== 0) return null; try { return JSON.parse(r.stdout); } catch { return null; } };

  // ---- GitHub access ------------------------------------------------------
  if (gh("auth", "status").code !== 0) {
    out.push(fail("GitHub CLI is not logged in", "Every GitHub check needs it.", "gh auth login"));
    return out;
  }
  const info = ghJson("repo", "view", repo, "--json", "defaultBranchRef,visibility");
  if (!info) {
    out.push(fail(`Cannot read ${repo}`, "The repo does not exist or your login cannot see it.", `gh repo view ${repo}`));
    return out;
  }
  const branch = info.defaultBranchRef?.name ?? "main";
  out.push(pass(`${repo} is reachable`, `${info.visibility.toLowerCase()}, default branch ${branch}`));

  // ---- Repo secrets -------------------------------------------------------
  const secretNames = (gh("secret", "list", "-R", repo, "--json", "name").stdout.match(/"name":"([^"]+)"/g) ?? []).map((s) => s.slice(8, -1));
  for (const s of manifest.secrets.filter((x) => x.scope === "app" && !x.quiet)) {
    const why = s.what.split(". ")[0] + ".";
    const fix = `node scripts/secrets.mjs set ${s.derivedFrom ?? s.id}`;
    if (secretNames.includes(s.id)) out.push(pass(`Repo secret ${s.id} is set`));
    else out.push((s.required ? fail : warn)(`Repo secret ${s.id} is missing`, why, fix));
  }

  // ---- Labels -------------------------------------------------------------
  const labels = (ghJson("label", "list", "-R", repo, "--json", "name", "--limit", "200") ?? []).map((l) => l.name);
  for (const l of ["ai-fix", "ai-triaged"]) {
    labels.includes(l) ? out.push(pass(`Label ${l} exists`)) : out.push(fail(`Label ${l} is missing`, "Approvals and runs are triggered by it.", `gh label create ${l} -R ${repo}`));
  }

  // ---- Workflow files on the default branch -------------------------------
  const file = (path) => { const r = gh("api", `repos/${repo}/contents/${path}?ref=${branch}`, "-H", "Accept: application/vnd.github.raw+json"); return r.code === 0 ? r.stdout : null; };
  const wf = { "ai-fix.yml": "fail", "ai-guardrails.yml": "warn", "ai-approval-notify.yml": "warn", "ai-doctor.yml": "warn" };
  const bodies = {};
  for (const [name, level] of Object.entries(wf)) {
    bodies[name] = file(`.github/workflows/${name}`);
    if (bodies[name]) out.push(pass(`Workflow ${name} is on ${branch}`));
    else {
      const fix = `scripts/init.sh <path-to-app> <owner>   (then commit and push to ${branch}; issue-triggered workflows only run from the default branch)`;
      out.push(level === "fail" ? fail(`Workflow ${name} is missing from ${branch}`, "Labeling an issue will do nothing.", fix) : warn(`Workflow ${name} is missing from ${branch}`, undefined, fix));
    }
  }
  if (bodies["ai-fix.yml"] && !/^run-name:\s*["'][^"']*#\$\{\{[^"']*["']\s*$/m.test(bodies["ai-fix.yml"]))
    out.push(warn("ai-fix.yml does not name its runs with the issue number", "The dashboard cannot link runs to issues. (An unquoted `#` is read by YAML as a comment, so the number is silently dropped.)", 'Under `name: AI fix` use exactly:  run-name: "AI fix #${{ github.event.issue.number }}"'));

  // ---- harness.config.yml -------------------------------------------------
  const cfg = file("harness.config.yml");
  if (!cfg) out.push(fail("harness.config.yml is missing", "The fix workflow stops immediately without it.", "Copy harness.config.example.yml to the repo root and edit it."));
  else {
    const missing = ["project", "install", "lint", "types", "test"].filter((k) => !new RegExp(`^\\s*${k}:\\s*\\S`, "m").test(cfg));
    missing.length ? out.push(fail("harness.config.yml is incomplete", `Missing: ${missing.join(", ")}. All four check commands are required (use 'true' for a check the app lacks).`, "Edit harness.config.yml.")) : out.push(pass("harness.config.yml has the required keys"));
  }

  // ---- Repo settings ------------------------------------------------------
  const perms = ghJson("api", `repos/${repo}/actions/permissions/workflow`);
  if (perms?.can_approve_pull_request_reviews) out.push(pass("Actions may open pull requests"));
  else out.push(fail("Actions may not open pull requests", "The fix run would finish its work and then fail to open the PR.", `gh api -X PUT repos/${repo}/actions/permissions/workflow -F can_approve_pull_request_reviews=true -f default_workflow_permissions=write`));

  const prot = gh("api", `repos/${repo}/branches/${branch}/protection`);
  out.push(prot.code === 0 ? pass(`${branch} has branch protection`) : warn(`${branch} has no branch protection`, "The guardrails check is only advisory: a failing agent PR can still be merged.", `GitHub > ${repo} > Settings > Branches: require the 'AI guardrails' check and one review.`));

  // ---- Worker -------------------------------------------------------------
  if (!worker) out.push(warn("No --worker address given", "The Worker checks were skipped.", "Re-run with --worker https://<your-worker>.workers.dev"));
  else {
    const health = await fetchJson(`${worker}/v1/health`);
    if (health.status !== 200) out.push(fail("The Worker is not answering", `GET ${worker}/v1/health returned ${health.status || health.error}.`, "cd server && npx wrangler deploy"));
    else {
      out.push(pass("The Worker answers /v1/health"));
      const dash = await fetchJson(`${worker}/v1/dashboard`);
      out.push(dash.status === 401 ? pass("The dashboard route is live (sign-in required)") : fail("The dashboard route is not behaving", `GET /v1/dashboard returned ${dash.status}, expected 401.`, "cd server && npx wrangler deploy"));
    }

    const serverDir = join(harnessDir, "server");
    if (!fileExists(serverDir)) out.push(warn("Worker secret and deployment checks skipped", `${serverDir} not found.`));
    else {
      const sl = sh("npx", ["--no-install", "wrangler", "secret", "list"], { cwd: serverDir });
      const have = sl.code === 0 ? names(sl.stdout) : null;
      if (!have) out.push(warn("Could not list Worker secrets", "wrangler is not installed or not logged in.", "cd server && npm install && npx wrangler login"));
      else {
        for (const s of manifest.secrets.filter((x) => x.scope === "worker")) {
          const why = s.what.split(". ")[0] + ".";
          const fix = `node scripts/secrets.mjs set ${s.id}`;
          if (have.includes(s.workerName)) out.push(pass(`Worker secret ${s.workerName} is set`));
          else out.push((s.required ? fail : warn)(`Worker secret ${s.workerName} is missing`, why, fix));
        }
      }

      // The state we hit once: a newer version uploaded but never made live.
      const ver = sh("npx", ["--no-install", "wrangler", "versions", "list"], { cwd: serverDir });
      const dep = sh("npx", ["--no-install", "wrangler", "deployments", "list"], { cwd: serverDir });
      const newest = [...(ver.stdout.matchAll(/Version ID:\s+([0-9a-f-]{36})/g))].map((m) => m[1]).pop();
      const live = [...(dep.stdout.matchAll(/\(100%\)\s+([0-9a-f-]{36})/g))].map((m) => m[1]).pop();
      if (newest && live) out.push(newest === live ? pass("The newest Worker version is the live one") : fail("The newest Worker version is not the live one", "A version was uploaded but never deployed, so secret changes will be refused.", "cd server && npx wrangler deploy"));

      const tomlPath = join(serverDir, "wrangler.toml");
      if (fileExists(tomlPath)) {
        const allowed = (/ALLOWED_REPOS\s*=\s*"([^"]*)"/.exec(readFile(tomlPath))?.[1] ?? "").split(",").map((s) => s.trim());
        allowed.includes(repo) ? out.push(pass(`${repo} is in the Worker's ALLOWED_REPOS`)) : out.push(fail(`${repo} is not in the Worker's ALLOWED_REPOS`, "Approval taps for this repo will be refused (403).", "Add it to ALLOWED_REPOS in server/wrangler.toml, then: cd server && npx wrangler deploy"));
      }
    }
  }

  out.push({ level: "info", title: "Not checkable from here", detail: "The Worker's GitHub token (permissions and expiry): sign in to the dashboard; its Problems strip checks both. `node scripts/secrets.mjs list` also warns as it nears expiry." });

  // ---- Remote: the repo's own Anthropic key ------------------------------
  if (remote) {
    if (!bodies["ai-doctor.yml"]) out.push(warn("Remote check skipped", "ai-doctor.yml is not installed.", "scripts/init.sh <path-to-app> <owner>"));
    else {
      const started = Date.now();
      gh("workflow", "run", "ai-doctor.yml", "-R", repo);
      let run = null;
      for (let i = 0; i < 30 && !run; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        run = (ghJson("run", "list", "-R", repo, "--workflow", "ai-doctor.yml", "--limit", "1", "--json", "databaseId,status,conclusion,createdAt") ?? []).find((r) => Date.parse(r.createdAt) >= started - 5000);
      }
      if (!run) out.push(warn("Remote check did not start", "The workflow could not be found after 2 minutes."));
      else {
        gh("run", "watch", String(run.databaseId), "-R", repo, "--exit-status");
        const done = ghJson("run", "view", String(run.databaseId), "-R", repo, "--json", "conclusion");
        if (done?.conclusion === "success") out.push(pass("The repo's ANTHROPIC_API_KEY works and the model is available"));
        else {
          const log = gh("run", "view", String(run.databaseId), "-R", repo, "--log-failed").stdout;
          const line = log.split("\n").map((l) => l.replace(/^.*?Z\s+/, "")).find((l) => /Preflight failed|check failed|is not set/i.test(l)) ?? "See the run for details.";
          out.push(fail("The remote check failed", line.replace(/^##\[error\]/, "").slice(0, 300), `gh run view ${run.databaseId} -R ${repo} --log-failed`));
        }
      }
    }
  }
  return out;
}

export function formatReport(results) {
  const icon = { pass: "PASS", warn: "WARN", fail: "FAIL", info: "NOTE" };
  const lines = [];
  for (const r of results) {
    lines.push(`${icon[r.level]}  ${r.title}${r.detail ? `\n      ${r.detail}` : ""}${r.fix ? `\n      fix: ${r.fix}` : ""}`);
  }
  const c = (l) => results.filter((r) => r.level === l).length;
  lines.push("", `${c("pass")} passed, ${c("warn")} warnings, ${c("fail")} failed.`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const a = { remote: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") a.repo = argv[++i];
    else if (argv[i] === "--worker") a.worker = argv[++i];
    else if (argv[i] === "--remote") a.remote = true;
  }
  a.worker ??= process.env.F2PR_WORKER;
  return a;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo) { console.error("Usage: node scripts/doctor.mjs --repo owner/app [--worker https://...workers.dev] [--remote]"); process.exit(2); }
  const results = await runDoctor(args, { sh: realSh, fetchJson: realFetchJson, readFile: (p) => readFileSync(p, "utf8"), fileExists: existsSync, harnessDir: ROOT, manifest: JSON.parse(readFileSync(join(ROOT, "secrets.manifest.json"), "utf8")) });
  console.log(formatReport(results));
  process.exit(results.some((r) => r.level === "fail") ? 1 : 0);
}
