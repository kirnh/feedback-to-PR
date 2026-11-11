import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatReport, runDoctor, type Result } from "../../scripts/doctor.mjs";

const REPO = "owner/app";
const WORKER = "https://w.example";
const CONFIG = "project: App\ncommands:\n  install: yarn install\n  lint: yarn lint\n  types: yarn tsc\n  test: yarn test\n";

interface World {
  ghAuth: boolean; repoVisible: boolean; secrets: string[]; labels: string[]; files: Record<string, string>;
  canOpenPrs: boolean; protectedBranch: boolean; workerSecrets: string[] | null; newestVersion: string; liveVersion: string;
  toml: string; health: number; dashboard: number;
}
const healthy = (): World => ({
  ghAuth: true, repoVisible: true,
  secrets: ["ANTHROPIC_API_KEY", "APPROVAL_SIGNING_KEY", "NTFY_TOPIC", "NTFY_PROGRESS_TOPIC"],
  labels: ["bug", "ai-fix", "ai-triaged"],
  files: {
    ".github/workflows/ai-fix.yml": 'name: AI fix\nrun-name: "AI fix #${{ github.event.issue.number }}"\n',
    ".github/workflows/ai-guardrails.yml": "x", ".github/workflows/ai-approval-notify.yml": "x", ".github/workflows/ai-doctor.yml": "x",
    "harness.config.yml": CONFIG,
  },
  canOpenPrs: true, protectedBranch: true,
  workerSecrets: ["SIGNING_KEY", "GITHUB_TOKEN", "DASHBOARD_PASS", "NTFY_PROGRESS_TOPIC"],
  newestVersion: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", liveVersion: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  toml: 'ALLOWED_REPOS = "owner/app, other/repo"', health: 200, dashboard: 401,
});

function deps(w: World) {
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const no = () => ({ code: 1, stdout: "", stderr: "x" });
  return {
    harnessDir: "/h",
    readFile: () => w.toml,
    fileExists: () => true,
    fetchJson: async (url: string) => (url.endsWith("/v1/health") ? { status: w.health, json: {} } : { status: w.dashboard, json: {} }),
    sh: (cmd: string, args: string[]) => {
      const a = args.join(" ");
      if (cmd === "gh") {
        if (a.startsWith("auth status")) return w.ghAuth ? ok() : no();
        if (a.startsWith("repo view")) return w.repoVisible ? ok(JSON.stringify({ defaultBranchRef: { name: "main" }, visibility: "PRIVATE" })) : no();
        if (a.startsWith("secret list")) return ok(JSON.stringify(w.secrets.map((name) => ({ name }))));
        if (a.startsWith("label list")) return ok(JSON.stringify(w.labels.map((name) => ({ name }))));
        if (a.includes("/contents/")) { const p = /contents\/([^?]+)\?/.exec(a)![1]; return p in w.files ? ok(w.files[p]) : no(); }
        if (a.includes("actions/permissions/workflow")) return ok(JSON.stringify({ can_approve_pull_request_reviews: w.canOpenPrs }));
        if (a.includes("/protection")) return w.protectedBranch ? ok("{}") : no();
      }
      if (cmd === "npx") {
        if (a.includes("secret list")) return w.workerSecrets ? ok("⛅️ wrangler\n" + JSON.stringify(w.workerSecrets.map((name) => ({ name, type: "secret_text" })), null, 2)) : no();
        if (a.includes("versions list")) return ok(`Version ID:  ${w.newestVersion}\n`);
        if (a.includes("deployments list")) return ok(`Version(s):  (100%) ${w.liveVersion}\n`);
      }
      return no();
    },
  };
}
const run = (w: World) => runDoctor({ repo: REPO, worker: WORKER }, deps(w));
const levels = (r: Result[], l: string) => r.filter((x) => x.level === l);
const find = (r: Result[], text: string) => r.find((x) => x.title.includes(text));

describe("doctor", () => {
  it("a healthy setup has no failures and no warnings", async () => {
    const r = await run(healthy());
    expect(levels(r, "fail")).toEqual([]);
    expect(levels(r, "warn")).toEqual([]);
    expect(levels(r, "pass").length).toBeGreaterThan(15);
  });

  it("stops at once, with the fix, when the GitHub CLI is not logged in", async () => {
    const r = await run({ ...healthy(), ghAuth: false });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ level: "fail", fix: "gh auth login" });
  });

  it("explains an unreadable repo", async () => {
    const r = await run({ ...healthy(), repoVisible: false });
    expect(levels(r, "fail")[0].title).toContain("Cannot read owner/app");
  });

  it("a missing Anthropic key is a failure with the exact command; missing phone secrets are only warnings", async () => {
    const r = await run({ ...healthy(), secrets: [] });
    expect(find(r, "ANTHROPIC_API_KEY")).toMatchObject({ level: "fail", fix: "gh secret set ANTHROPIC_API_KEY -R owner/app" });
    expect(find(r, "NTFY_TOPIC")?.level).toBe("warn");
    expect(find(r, "APPROVAL_SIGNING_KEY")?.level).toBe("warn");
  });

  it("missing labels fail with the create command", async () => {
    const r = await run({ ...healthy(), labels: ["bug"] });
    expect(find(r, "Label ai-fix")).toMatchObject({ level: "fail", fix: "gh label create ai-fix -R owner/app" });
    expect(find(r, "Label ai-triaged")?.level).toBe("fail");
  });

  it("a missing fix workflow is a failure; the others are warnings", async () => {
    const w = healthy();
    delete w.files[".github/workflows/ai-fix.yml"]; delete w.files[".github/workflows/ai-guardrails.yml"];
    const r = await run(w);
    expect(find(r, "ai-fix.yml")).toMatchObject({ level: "fail" });
    expect(find(r, "ai-fix.yml")?.fix).toContain("default branch");
    expect(find(r, "ai-guardrails.yml")?.level).toBe("warn");
  });

  it("warns when runs are not named, because the dashboard cannot link them", async () => {
    const w = healthy(); w.files[".github/workflows/ai-fix.yml"] = "name: AI fix\n";
    expect(find(await run(w), "does not name its runs")?.level).toBe("warn");
  });

  it("catches the unquoted run-name that YAML silently truncates at the #", async () => {
    const w = healthy(); w.files[".github/workflows/ai-fix.yml"] = "name: AI fix\nrun-name: AI fix #${{ github.event.issue.number }}\n";
    const r = find(await run(w), "does not name its runs");
    expect(r?.level).toBe("warn");
    expect(r?.detail).toContain("comment");
    expect(r?.fix).toContain('run-name: "AI fix #');
  });

  it("the shipped template passes its own check (it names runs with the issue number)", async () => {
    const w = healthy();
    w.files[".github/workflows/ai-fix.yml"] = readFileSync(new URL("../../templates/ai-fix.yml", import.meta.url), "utf8");
    expect(find(await run(w), "does not name its runs")).toBeUndefined();
  });

  it("flags a missing or incomplete config", async () => {
    const missing = healthy(); delete missing.files["harness.config.yml"];
    expect(find(await run(missing), "harness.config.yml is missing")?.level).toBe("fail");
    const partial = healthy(); partial.files["harness.config.yml"] = "project: App\ncommands:\n  install: yarn\n";
    const r = find(await run(partial), "incomplete");
    expect(r?.level).toBe("fail");
    expect(r?.detail).toContain("lint, types, test");
  });

  it("fails when Actions cannot open pull requests, with the repair command", async () => {
    const r = find(await run({ ...healthy(), canOpenPrs: false }), "may not open pull requests");
    expect(r?.level).toBe("fail");
    expect(r?.fix).toContain("can_approve_pull_request_reviews=true");
  });

  it("warns that guardrails are advisory without branch protection", async () => {
    const r = find(await run({ ...healthy(), protectedBranch: false }), "no branch protection");
    expect(r?.level).toBe("warn");
    expect(r?.detail).toContain("advisory");
  });

  it("fails when the Worker is down", async () => {
    const r = await run({ ...healthy(), health: 0 });
    expect(find(r, "not answering")?.level).toBe("fail");
  });

  it("fails loudly if the dashboard data route answers WITHOUT a login", async () => {
    const r = find(await run({ ...healthy(), dashboard: 200 }), "dashboard route is not behaving");
    expect(r?.level).toBe("fail");
    expect(r?.detail).toContain("expected 401");
  });

  it("reports missing Worker secrets: required ones fail, the dashboard passphrase warns", async () => {
    const r = await run({ ...healthy(), workerSecrets: ["SIGNING_KEY"] });
    expect(find(r, "GITHUB_TOKEN")?.level).toBe("fail");
    expect(find(r, "DASHBOARD_PASS")?.level).toBe("warn");
    expect(find(r, "DASHBOARD_PASS")?.fix).toContain("set-dashboard-passphrase");
    expect(find(r, "SIGNING_KEY")?.level).toBe("pass");
  });

  it("catches a Worker version that was uploaded but never made live", async () => {
    const r = find(await run({ ...healthy(), newestVersion: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }), "not the live one");
    expect(r?.level).toBe("fail");
    expect(r?.fix).toContain("wrangler deploy");
  });

  it("fails when the repo is not in the Worker's allowlist", async () => {
    const r = find(await run({ ...healthy(), toml: 'ALLOWED_REPOS = "someone/else"' }), "not in the Worker's ALLOWED_REPOS");
    expect(r?.level).toBe("fail");
    expect(r?.detail).toContain("403");
  });

  it("degrades to a warning when wrangler cannot be used", async () => {
    const r = await run({ ...healthy(), workerSecrets: null });
    expect(find(r, "Could not list Worker secrets")?.level).toBe("warn");
  });

  it("skips the Worker checks, visibly, when no address is given", async () => {
    const r = await runDoctor({ repo: REPO }, deps(healthy()));
    expect(find(r, "No --worker address")?.level).toBe("warn");
  });
});

describe("formatReport", () => {
  it("prints each problem with its fix and a summary line", async () => {
    const text = formatReport(await run({ ...healthy(), secrets: [], labels: [] }));
    expect(text).toContain("FAIL  Repo secret ANTHROPIC_API_KEY is missing");
    expect(text).toContain("fix: gh secret set ANTHROPIC_API_KEY -R owner/app");
    expect(text).toMatch(/\d+ passed, \d+ warnings, \d+ failed\./);
  });
});
