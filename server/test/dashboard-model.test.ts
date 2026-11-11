import { describe, expect, it } from "vitest";
import {
  buildItems, computeTotals, issueNumberFromBranch, issueNumberFromRun, parseTraceFromComments, summarizeTrace,
  type GhIssue, type GhPr, type GhRun, type TraceSummary,
} from "../src/dashboard/model";

const issue = (n: number, labels: string[], over: Partial<GhIssue> = {}): GhIssue => ({
  number: n, title: `Issue ${n}`, state: "open", labels: labels.map((name) => ({ name })), html_url: `https://github.com/o/r/issues/${n}`,
  created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T01:00:00Z", comments: 0, ...over,
});
const pr = (n: number, branchIssue: number, over: Partial<GhPr> = {}): GhPr => ({
  number: n, state: "open", draft: true, merged_at: null, html_url: `https://github.com/o/r/pull/${n}`, head: { ref: `ai/issue-${branchIssue}` }, created_at: "2026-11-10T02:00:00Z", ...over,
});
const run = (id: number, n: number, over: Partial<GhRun> = {}): GhRun => ({
  id, display_title: `AI fix #${n}`, status: "completed", conclusion: "success", html_url: `https://github.com/o/r/actions/runs/${id}`, created_at: "2026-11-10T01:30:00Z", ...over,
});
const stageOf = (i: GhIssue, prs: GhPr[] = [], runs: GhRun[] = []) => buildItems("o/r", [i], prs, runs, new Map())[0]?.stage;

describe("stage rules", () => {
  it("triaged and not approved -> needs you", () => expect(stageOf(issue(1, ["ai-triaged"]))).toBe("need"));
  it("approved with no run yet -> running (starting)", () => expect(stageOf(issue(1, ["ai-triaged", "ai-fix"]))).toBe("run"));
  it("approved with an in-progress run -> running", () => expect(stageOf(issue(1, ["ai-fix"]), [], [run(9, 1, { status: "in_progress", conclusion: null })])).toBe("run"));
  it("queued run -> running", () => expect(stageOf(issue(1, ["ai-fix"]), [], [run(9, 1, { status: "queued", conclusion: null })])).toBe("run"));
  it("run failed -> failed, with the reason", () => {
    const [i] = buildItems("o/r", [issue(1, ["ai-fix"])], [], [run(9, 1, { conclusion: "failure" })], new Map());
    expect(i.stage).toBe("fail");
    expect(i.detail).toContain("failure");
  });
  it("run succeeded but no PR -> failed (no pull request opened)", () => {
    const [i] = buildItems("o/r", [issue(1, ["ai-fix"])], [], [run(9, 1)], new Map());
    expect(i.stage).toBe("fail");
    expect(i.detail).toMatch(/no pull request/i);
  });
  it("open draft PR -> to review", () => expect(stageOf(issue(1, ["ai-fix"]), [pr(5, 1)], [run(9, 1)])).toBe("review"));
  it("merged PR -> shipped", () => expect(stageOf(issue(1, ["ai-fix"]), [pr(5, 1, { state: "closed", merged_at: "2026-11-10T05:00:00Z" })])).toBe("done"));
  it("PR closed without merge -> rejected", () => expect(stageOf(issue(1, ["ai-fix"]), [pr(5, 1, { state: "closed" })])).toBe("rejected"));
  it("issue closed as not planned -> rejected", () => expect(stageOf(issue(1, ["ai-triaged"], { state: "closed", state_reason: "not_planned" }))).toBe("rejected"));
  it("a merged PR wins over a stale failed run", () =>
    expect(stageOf(issue(1, ["ai-fix"]), [pr(5, 1, { state: "closed", merged_at: "2026-11-10T05:00:00Z" })], [run(9, 1, { conclusion: "failure" })])).toBe("done"));
  it("uses the NEWEST run for an issue that was re-run", () => {
    const old = run(1, 1, { conclusion: "failure", created_at: "2026-11-09T00:00:00Z" });
    const fresh = run(2, 1, { status: "in_progress", conclusion: null, created_at: "2026-11-10T00:00:00Z" });
    expect(stageOf(issue(1, ["ai-fix"]), [], [old, fresh])).toBe("run");
  });
});

describe("what is included", () => {
  it("ignores unrelated issues and pull requests returned by the issues API", () => {
    const items = buildItems("o/r", [issue(1, ["bug"]), issue(2, ["ai-triaged"], { pull_request: {} }), issue(3, ["ai-triaged"])], [], [], new Map());
    expect(items.map((i) => i.issue)).toEqual([3]);
  });
  it("ignores PRs and runs that belong to other issues", () => {
    const [i] = buildItems("o/r", [issue(1, ["ai-fix"])], [pr(5, 2)], [run(9, 2, { conclusion: "failure" })], new Map());
    expect(i.stage).toBe("run");
    expect(i.pr).toBeUndefined();
    expect(i.run).toBeUndefined();
  });
  it("orders needs-you first, then by newest activity", () => {
    const items = buildItems("o/r", [
      issue(1, ["ai-fix"], { updated_at: "2026-11-10T09:00:00Z" }),
      issue(2, ["ai-triaged"], { updated_at: "2026-11-09T09:00:00Z" }),
      issue(3, ["ai-triaged"], { updated_at: "2026-11-10T09:00:00Z" }),
    ], [], [], new Map());
    expect(items.map((i) => i.issue)).toEqual([3, 2, 1]);
  });
});

describe("linking runs and branches to issues", () => {
  it.each([["AI fix #12", 12], ["AI fix #7 extra", 7], ["no number", null], ["", null]])("run title %j -> %s", (t, n) =>
    expect(issueNumberFromRun(run(1, 1, { display_title: t }))).toBe(n));
  it.each([["ai/issue-4", 4], ["ai/issue-4x", null], ["main", null], ["feature/ai/issue-4", null]])("branch %j -> %s", (b, n) =>
    expect(issueNumberFromBranch(b)).toBe(n));
});

describe("embedded trace", () => {
  const trace = {
    run: { url: "https://github.com/o/r/actions/runs/1" },
    chain: [
      { stage: "approval", issue: 3, approved_by: "kirnh" },
      { stage: "agent", model_requested: "claude-sonnet-5-5", models_used: ["claude-haiku-5-5", "claude-sonnet-5-5"], outcome: "success", turns: 9, cost_usd: 0.1035 },
      { stage: "verification", checks: [{ check: "Lint", baseline_exit: 1, after_exit: 1 }, { check: "Tests", baseline_exit: 0, after_exit: 0 }], introduced_failures: [] },
      { stage: "pull_request", outcome: "pr_opened", pr_url: "https://github.com/o/r/pull/2", files_changed: ["a.ts", "b.ts"] },
    ],
  };
  const comment = (body: string, at = "2026-11-10T03:00:00Z") => ({ body, created_at: at });

  it("summarizes the main model (not the helper model), cost, turns, checks and files", () => {
    const s = summarizeTrace(trace)!;
    expect(s).toMatchObject({ approver: "kirnh", model: "claude-sonnet-5-5", cost: 0.1035, turns: 9, files: 2, introduced: [] });
    expect(s.checks).toEqual([{ name: "Lint", beforePass: false, afterPass: false }, { name: "Tests", beforePass: true, afterPass: true }]);
  });
  it("reads the marker out of a comment", () => {
    const body = `### Judgement trace\n\n| a | b |\n\n<!-- f2pr-trace ${JSON.stringify(trace)} -->`;
    expect(parseTraceFromComments([comment(body)])?.cost).toBe(0.1035);
  });
  it("takes the NEWEST comment that has a trace", () => {
    const older = comment(`<!-- f2pr-trace ${JSON.stringify({ chain: [{ stage: "agent", cost_usd: 1 }] })} -->`, "2026-11-09T00:00:00Z");
    const newer = comment(`<!-- f2pr-trace ${JSON.stringify({ chain: [{ stage: "agent", cost_usd: 2 }] })} -->`, "2026-11-10T00:00:00Z");
    expect(parseTraceFromComments([older, newer])?.cost).toBe(2);
  });
  it("ignores the triage marker, plain comments and corrupt JSON", () => {
    expect(parseTraceFromComments([comment('<!-- f2pr-trace:triage {"x":1} -->'), comment("hello"), comment("<!-- f2pr-trace {not json} -->")])).toBeNull();
  });
  it("survives a trace with no chain", () => expect(summarizeTrace({})).toEqual(expect.objectContaining({})));
  it("returns null for non-objects", () => { expect(summarizeTrace(null)).toBeNull(); expect(summarizeTrace("x")).toBeNull(); });
});

describe("totals", () => {
  const withCost = (cost: number): TraceSummary => ({ cost });
  it("counts every stage and sums spend only inside the window", () => {
    const now = Date.parse("2026-11-11T00:00:00Z");
    const traces = new Map<number, TraceSummary>([[1, withCost(0.1)], [2, withCost(0.2)]]);
    const items = buildItems("o/r", [
      issue(1, ["ai-fix"], { updated_at: "2026-11-10T00:00:00Z" }),
      issue(2, ["ai-fix"], { updated_at: "2026-09-01T00:00:00Z" }),
      issue(3, ["ai-triaged"]),
    ], [pr(5, 1)], [run(9, 2, { created_at: "2026-09-01T00:00:00Z" })], traces);
    const t = computeTotals(items, now);
    expect(t.counts.need).toBe(1);
    expect(t.counts.review).toBe(1);
    expect(t.spentUsd).toBeCloseTo(0.1, 5); // item 2 is older than 30 days
  });
});

describe("failure reasons and older runs", () => {
  it("a failed run shows why, when the trace says so", () => {
    const traces = new Map<number, TraceSummary>([[1, { error: "Anthropic API check failed (HTTP 400): credit balance is too low." }]]);
    const [i] = buildItems("o/r", [issue(1, ["ai-fix"])], [], [run(9, 1, { conclusion: "failure" })], traces);
    expect(i.stage).toBe("fail");
    expect(i.detail).toContain("Why: Anthropic API check failed (HTTP 400)");
  });
  it("a failed run without a reason still reads sensibly", () => {
    const [i] = buildItems("o/r", [issue(1, ["ai-fix"])], [], [run(9, 1, { conclusion: "failure" })], new Map());
    expect(i.detail).not.toContain("Why:");
  });
  it("matches an older run named after the issue title", () => {
    const old = run(5, 0, { display_title: "Issue 1", conclusion: "failure" });
    const [i] = buildItems("o/r", [issue(1, ["ai-fix"])], [], [old], new Map());
    expect(i.stage).toBe("fail");
    expect(i.run?.id).toBe(5);
  });
  it("never matches a numbered run to a different issue by title", () => {
    const other = run(6, 9, { display_title: "AI fix #9" });
    const [i] = buildItems("o/r", [issue(1, ["ai-fix"])], [], [other], new Map());
    expect(i.run).toBeUndefined();
  });
  it("reads the error out of a trace", () => {
    expect(summarizeTrace({ chain: [{ stage: "agent", error: "boom" }] })?.error).toBe("boom");
  });
});
