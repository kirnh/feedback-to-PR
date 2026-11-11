import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeTrace } from "../src/dashboard/model";

const run = promisify(execFile);
const scripts = new URL("../../scripts/", import.meta.url).pathname;
const haveTools = (() => { try { require("node:child_process").execFileSync("jq", ["--version"]); return true; } catch { return false; } })();

async function sh(script: string, env: Record<string, string>, dir: string) {
  try {
    const r = await run("bash", [join(scripts, script)], { cwd: dir, env: { ...process.env, TRACE_DIR: dir, ...env } });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}
const tmp = () => mkdtempSync(join(tmpdir(), "f2pr-"));
const reason = (dir: string) => (existsSync(join(dir, "failure_reason.txt")) ? readFileSync(join(dir, "failure_reason.txt"), "utf8") : null);

describe.runIf(haveTools)("preflight-anthropic.sh", () => {
  let server: Server;
  let url = "";
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  let lastKey = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      lastKey = String(req.headers["x-api-key"] ?? "");
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
  });
  afterAll(() => server.close());

  const go = (env: Record<string, string> = {}) => {
    const dir = tmp();
    return sh("preflight-anthropic.sh", { ANTHROPIC_API_KEY: "sk-ant-test-SECRET", MODEL: "claude-sonnet-5-5", ANTHROPIC_API_URL: url, ...env }, dir).then((r) => ({ ...r, dir }));
  };

  it("passes quietly when the API accepts the request", async () => {
    reply = { status: 200, body: { content: [] } };
    const r = await go();
    expect(r.code).toBe(0);
    expect(reason(r.dir)).toBeNull();
    expect(lastKey).toBe("sk-ant-test-SECRET"); // sent to the API as a header, as it should be
  });

  it.each([
    [401, "invalid x-api-key", "HTTP 401", "rejected"],
    [400, "Your credit balance is too low to access the Anthropic API.", "credit balance is too low", "billing"],
    [404, "model: claude-nope", "HTTP 404", "model was not found"],
    [429, "rate limit exceeded", "HTTP 429", "quota"],
    [403, "forbidden", "HTTP 403", "not allowed"],
    [529, "overloaded", "HTTP 529", "server error"],
  ])("HTTP %i is reported with the API's own message and a fix", async (status, message, ...expected) => {
    reply = { status, body: { type: "error", error: { type: "x", message } } };
    const r = await go();
    expect(r.code).toBe(1);
    for (const word of expected) expect(reason(r.dir)).toContain(word);
  });

  it("never writes the API key into the reason or the log", async () => {
    reply = { status: 401, body: { error: { message: "invalid x-api-key" } } };
    const r = await go();
    expect(reason(r.dir)).not.toContain("SECRET");
    expect(r.out).not.toContain("SECRET");
  });

  it("explains a missing key and a missing model", async () => {
    expect(reason((await go({ ANTHROPIC_API_KEY: "" })).dir)).toContain("ANTHROPIC_API_KEY is not set");
    expect(reason((await go({ MODEL: "" })).dir)).toContain("No model is configured");
  });

  it("explains an unreachable API", async () => {
    const r = await go({ ANTHROPIC_API_URL: "http://127.0.0.1:1/v1/messages" });
    expect(r.code).toBe(1);
    expect(reason(r.dir)).toContain("Could not reach");
  });
});

describe.runIf(haveTools)("explain-agent-failure.sh", () => {
  const exec = (dir: string, result: Record<string, unknown>) => {
    const f = join(dir, "exec.json");
    writeFileSync(f, JSON.stringify([{ type: "system" }, { type: "result", ...result }]));
    return f;
  };

  it("uses the agent's own error text when there is one", async () => {
    const dir = tmp();
    await sh("explain-agent-failure.sh", { EXECUTION_FILE: exec(dir, { subtype: "error_during_execution", is_error: true, result: "Credit balance is too low" }) }, dir);
    expect(reason(dir)).toContain("Credit balance is too low");
  });

  it("explains the silent 199 ms failure (no message, no model used)", async () => {
    const dir = tmp();
    await sh("explain-agent-failure.sh", { EXECUTION_FILE: exec(dir, { subtype: "success", is_error: true, duration_ms: 199, num_turns: 1, modelUsage: {} }) }, dir);
    const r = reason(dir)!;
    expect(r).toContain("199 ms");
    expect(r).toContain("no model");
    expect(r).toContain("rejected before it started");
  });

  it("copes with a missing or unreadable log", async () => {
    const dir = tmp();
    await sh("explain-agent-failure.sh", { EXECUTION_FILE: join(dir, "nope.json") }, dir);
    expect(reason(dir)).toContain("failed before writing a log");
    const dir2 = tmp();
    writeFileSync(join(dir2, "exec.json"), "not json");
    await sh("explain-agent-failure.sh", { EXECUTION_FILE: join(dir2, "exec.json") }, dir2);
    expect(reason(dir2)).toContain("failed before writing a log");
  });

  it("keeps a more specific reason that the preflight already recorded", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "failure_reason.txt"), "Anthropic API check failed (HTTP 401)");
    await sh("explain-agent-failure.sh", { EXECUTION_FILE: exec(dir, { result: "other" }) }, dir);
    expect(reason(dir)).toBe("Anthropic API check failed (HTTP 401)");
  });

  it("truncates a long message to one short line", async () => {
    const dir = tmp();
    await sh("explain-agent-failure.sh", { EXECUTION_FILE: exec(dir, { subtype: "x", result: "line one\nline two ".repeat(100) }) }, dir);
    expect(reason(dir)!.length).toBeLessThanOrEqual(300);
    expect(reason(dir)).not.toContain("\n");
  });
});

describe.runIf(haveTools)("the reason reaches the trace, the phone and the dashboard", () => {
  function setup(reasonText: string) {
    const dir = tmp();
    mkdirSync(join(dir, "checks"));
    mkdirSync(join(dir, ".harness/prompts"), { recursive: true });
    for (const [f, c] of [["harness.config.yml", "project: X\n"], [".harness/prompts/fix.md", "r\n"], ["task.md", "t\n"], ["changed.txt", ""], ["issue.json", JSON.stringify({ number: 3, title: "t", body: "b" })], ["failure_reason.txt", reasonText]] as const) writeFileSync(join(dir, f), c);
    return dir;
  }
  const baseEnv = { AGENT_OUTCOME: "skipped", DIFF_CHANGED: "", RUN_URL: "https://github.com/o/r/actions/runs/1", REPO: "o/r", BASE_SHA: "d", HARNESS_REF: "main", HARNESS_SHA: "c", STARTED_AT: "2026-11-11T00:00:00Z", ISSUE: "3", APPROVED_BY: "kirnh", RUNNER: "claude-code", MODEL: "claude-sonnet-5-5" };

  it("write-trace records it; the dashboard parser reads it back", async () => {
    const why = "Anthropic API check failed (HTTP 400): credit balance is too low.";
    const dir = setup(why);
    await sh("write-trace.sh", baseEnv, dir);
    const trace = JSON.parse(readFileSync(join(dir, "trace.json"), "utf8"));
    expect(trace.chain.find((s: { stage: string }) => s.stage === "agent").error).toBe(why);
    expect(readFileSync(join(dir, "trace.md"), "utf8")).toContain("why it failed: " + why);
    expect(summarizeTrace(trace)?.error).toBe(why);
  });

  it("the phone message carries the reason instead of a generic line", async () => {
    const why = "Anthropic API check failed (HTTP 401): invalid x-api-key.";
    const dir = setup(why);
    await sh("write-trace.sh", baseEnv, dir);
    const r = await sh("notify-result.sh", { ...baseEnv, TOPIC_ACT: "act", NTFY_DRY_RUN: "1", ISSUE_URL: "https://github.com/o/r/issues/3" }, dir);
    const payload = JSON.parse(r.out.trim().split("\n").find((l) => l.startsWith("{"))!);
    expect(payload.title).toContain("Run failed");
    expect(payload.message).toBe(why);
    expect(payload.priority).toBe(5);
  });

  it("without a reason the phone message falls back to the generic line", async () => {
    const dir = setup("");
    await sh("write-trace.sh", baseEnv, dir);
    const r = await sh("notify-result.sh", { ...baseEnv, TOPIC_ACT: "act", NTFY_DRY_RUN: "1", ISSUE_URL: "u" }, dir);
    expect(JSON.parse(r.out.trim().split("\n").find((l) => l.startsWith("{"))!).message).toContain("did not finish");
  });
});
