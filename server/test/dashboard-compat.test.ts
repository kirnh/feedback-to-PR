import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storedPassphrase as scriptHash } from "../scripts/lib/passphrase-hash.mjs";
import { checkPassphrase } from "../src/dashboard/auth";
import { parseTraceFromComments } from "../src/dashboard/model";

const script = new URL("../../scripts/write-trace.sh", import.meta.url).pathname;
const haveJq = (() => { try { execFileSync("jq", ["--version"]); return true; } catch { return false; } })();

describe("scripts/write-trace.sh <-> dashboard parser", () => {
  function runScript(opts: { checks: Record<string, [number, number]>; outcome?: "pr" | "none"; hostile?: string }) {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    mkdirSync(join(dir, "checks"));
    mkdirSync(join(dir, ".harness/prompts"), { recursive: true });
    writeFileSync(join(dir, "harness.config.yml"), "project: X\n");
    writeFileSync(join(dir, ".harness/prompts/fix.md"), "rules\n");
    writeFileSync(join(dir, "task.md"), "task\n");
    writeFileSync(join(dir, "issue.json"), JSON.stringify({ number: 3, title: "t", body: "b" }));
    for (const [name, [before, after]] of Object.entries(opts.checks)) {
      writeFileSync(join(dir, `checks/baseline.${name}.code`), String(before));
      writeFileSync(join(dir, `checks/after.${name}.code`), String(after));
    }
    if (opts.outcome !== "none") writeFileSync(join(dir, "pr_url.txt"), "https://github.com/o/r/pull/8\n");
    writeFileSync(join(dir, "commit_sha.txt"), "abc123\n");
    writeFileSync(join(dir, "changed.txt"), opts.hostile ? `${opts.hostile}\nsrc/b.ts\n` : "src/a.ts\nsrc/b.ts\n");
    writeFileSync(join(dir, "exec.json"), JSON.stringify([{ type: "system" }, { type: "result", num_turns: 9, total_cost_usd: 0.1035, duration_ms: 1000, modelUsage: { "claude-sonnet-5-5": {}, "claude-haiku-5-5": {} } }]));
    execFileSync("bash", [script], {
      cwd: dir,
      env: { ...process.env, TRACE_DIR: dir, EXECUTION_FILE: join(dir, "exec.json"), AGENT_OUTCOME: "success", DIFF_CHANGED: opts.outcome === "none" ? "false" : "true",
        RUN_URL: "https://github.com/o/r/actions/runs/1", REPO: "o/r", BASE_SHA: "deadbeef", HARNESS_REF: "main", HARNESS_SHA: "cafebabe1234",
        STARTED_AT: "2026-11-10T00:00:00Z", ISSUE: "3", APPROVED_BY: "kirnh", RUNNER: "claude-code", MODEL: "claude-sonnet-5-5" },
    });
    return { md: readFileSync(join(dir, "trace.md"), "utf8"), json: readFileSync(join(dir, "trace.json"), "utf8") };
  }

  it.runIf(haveJq && existsSync(script))("the comment's hidden trace is read back with the right cost, model, checks and files", () => {
    const { md } = runScript({ checks: { Lint: [1, 1], Types: [0, 1], Tests: [0, 0] } });
    expect(md).toContain("### Judgement trace");
    const s = parseTraceFromComments([{ body: md, created_at: "2026-11-10T01:00:00Z" }])!;
    expect(s).toMatchObject({ approver: "kirnh", model: "claude-sonnet-5-5", cost: 0.1035, turns: 9, files: 2, introduced: ["Types"] });
    expect(s.checks).toEqual([
      { name: "Lint", beforePass: false, afterPass: false },
      { name: "Types", beforePass: true, afterPass: false },
      { name: "Tests", beforePass: true, afterPass: true },
    ]);
  });

  it.runIf(haveJq && existsSync(script))("a file name containing '-->' cannot break out of the hidden comment", () => {
    const { md } = runScript({ checks: { Lint: [0, 0] }, hostile: "src/evil-->name.ts" });
    const hidden = md.slice(md.indexOf("<!-- f2pr-trace"));
    expect(hidden.match(/-->/g)).toHaveLength(1); // only the closing marker
    expect(parseTraceFromComments([{ body: md, created_at: "2026-11-10T01:00:00Z" }])?.files).toBe(2);
  });

  it.runIf(haveJq && existsSync(script))("a run with no PR still produces a parseable trace", () => {
    const { md } = runScript({ checks: { Lint: [0, 0] }, outcome: "none" });
    expect(parseTraceFromComments([{ body: md, created_at: "2026-11-10T01:00:00Z" }])).not.toBeNull();
  });
});

describe("scripts/lib/passphrase-hash.mjs <-> Worker", () => {
  it("a hash made by the setup script is accepted by the Worker for the right passphrase only", async () => {
    const stored = await scriptHash("four random words here");
    expect(await checkPassphrase("four random words here", stored)).toBe(true);
    expect(await checkPassphrase("four random words", stored)).toBe(false);
  });
});
