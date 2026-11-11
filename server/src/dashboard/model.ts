// Pure logic: turn raw GitHub data into dashboard items. No network, no clock, easy to test.

export type Stage = "need" | "run" | "review" | "fail" | "done" | "rejected";

export interface GhIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: Array<{ name: string } | string>;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  comments: number;
  pull_request?: unknown;
}

export interface GhPr {
  number: number;
  state: "open" | "closed";
  draft?: boolean;
  merged_at: string | null;
  html_url: string;
  head: { ref: string };
  created_at: string;
}

export interface GhRun {
  id: number;
  display_title?: string;
  name?: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  run_started_at?: string | null;
}

/** The parts of a judgement trace the dashboard shows. Everything is optional: traces vary by outcome. */
export interface TraceSummary {
  approver?: string;
  model?: string;
  cost?: number;
  turns?: number;
  agentOutcome?: string;
  /** Why the run failed, in plain words (from the preflight or the agent's own log) */
  error?: string;
  checks?: Array<{ name: string; beforePass: boolean; afterPass: boolean | null }>;
  introduced?: string[];
  files?: number;
  runUrl?: string;
}

export interface Item {
  repo: string;
  issue: number;
  title: string;
  url: string;
  stage: Stage;
  stageLabel: string;
  /** Why it is in this stage, in plain words */
  detail: string;
  /** ISO time of the last meaningful change */
  at: string;
  pr?: { number: number; url: string; draft: boolean; merged: boolean };
  run?: { id: number; url: string; status: string; conclusion: string | null; startedAt: string };
  trace?: TraceSummary;
}

export const STAGE_LABEL: Record<Stage, string> = {
  need: "Needs you",
  run: "Running",
  review: "To review",
  fail: "Failed",
  done: "Shipped",
  rejected: "Rejected",
};

const labelNames = (i: GhIssue) => i.labels.map((l) => (typeof l === "string" ? l : l.name));

/** The fix workflow's caller sets `run-name: AI fix #<n>`; that is the reliable link from run to issue. */
export function issueNumberFromRun(run: GhRun): number | null {
  const m = /#(\d+)\b/.exec(run.display_title ?? run.name ?? "");
  return m ? Number(m[1]) : null;
}

export function issueNumberFromBranch(ref: string): number | null {
  const m = /^ai\/issue-(\d+)$/.exec(ref);
  return m ? Number(m[1]) : null;
}

/** Newest first. */
const byNewest = <T extends { created_at: string }>(a: T, b: T) => Date.parse(b.created_at) - Date.parse(a.created_at);

export function buildItems(
  repo: string,
  issues: GhIssue[],
  prs: GhPr[],
  runs: GhRun[],
  traces: Map<number, TraceSummary>,
): Item[] {
  const items: Item[] = [];
  for (const issue of issues) {
    if (issue.pull_request) continue; // the issues API also returns PRs
    const labels = labelNames(issue);
    if (!labels.includes("ai-triaged") && !labels.includes("ai-fix")) continue;

    const pr = prs.filter((p) => issueNumberFromBranch(p.head.ref) === issue.number).sort(byNewest)[0];
    // Runs are named `AI fix #<n>`. Older runs were named after the issue title, so fall back to that.
    const run =
      runs.filter((r) => issueNumberFromRun(r) === issue.number).sort(byNewest)[0] ??
      runs.filter((r) => issueNumberFromRun(r) === null && (r.display_title ?? r.name) === issue.title).sort(byNewest)[0];
    const trace = traces.get(issue.number);

    let stage: Stage;
    let detail: string;
    let at = issue.updated_at;

    if (pr?.merged_at) {
      stage = "done"; detail = `Merged as PR #${pr.number}.`; at = pr.merged_at;
    } else if (pr && pr.state === "closed") {
      stage = "rejected"; detail = `PR #${pr.number} was closed without merging.`;
    } else if (pr) {
      stage = "review"; detail = `${pr.draft ? "Draft PR" : "PR"} #${pr.number} is waiting for your review.`; at = pr.created_at;
    } else if (issue.state === "closed" && issue.state_reason === "not_planned") {
      stage = "rejected"; detail = "Closed as not planned.";
    } else if (issue.state === "closed") {
      stage = "done"; detail = "Issue closed."; at = issue.closed_at ?? at;
    } else if (labels.includes("ai-fix")) {
      if (!run) {
        stage = "run"; detail = "Approved. The run is starting.";
      } else if (run.status !== "completed") {
        stage = "run"; detail = "The agent is working.";
      } else if (run.conclusion === "success") {
        stage = "fail"; detail = "The run finished but opened no pull request (the agent may have made no changes).";
      } else {
        stage = "fail"; detail = `The run ended with: ${run.conclusion ?? "unknown"}.`;
      }
      if (run) at = run.run_started_at ?? run.created_at;
    } else {
      stage = "need"; detail = "Waiting for your approval.";
    }

    if (stage === "fail" && trace?.error) detail = `${detail} Why: ${trace.error}`;

    items.push({
      repo, issue: issue.number, title: issue.title, url: issue.html_url, stage, stageLabel: STAGE_LABEL[stage], detail, at,
      pr: pr ? { number: pr.number, url: pr.html_url, draft: !!pr.draft, merged: !!pr.merged_at } : undefined,
      run: run ? { id: run.id, url: run.html_url, status: run.status ?? "unknown", conclusion: run.conclusion, startedAt: run.run_started_at ?? run.created_at } : undefined,
      trace,
    });
  }
  // Needs-you first, then newest activity.
  const order: Record<Stage, number> = { need: 0, run: 1, review: 2, fail: 3, done: 4, rejected: 5 };
  return items.sort((a, b) => order[a.stage] - order[b.stage] || Date.parse(b.at) - Date.parse(a.at));
}

/**
 * Read the exact trace the fix workflow embeds in its issue comment as
 * `<!-- f2pr-trace {json} -->` (the triage marker has a colon and does not match).
 * Returns the newest comment's trace, or null.
 */
export function parseTraceFromComments(comments: Array<{ body?: string | null; created_at: string }>): TraceSummary | null {
  const sorted = [...comments].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const c of sorted) {
    const m = /<!--\s*f2pr-trace\s+(\{[\s\S]*?\})\s*-->/.exec(c.body ?? "");
    if (!m) continue;
    try {
      return summarizeTrace(JSON.parse(m[1]));
    } catch {
      continue;
    }
  }
  return null;
}

type Chain = Array<Record<string, unknown>>;

export function summarizeTrace(t: unknown): TraceSummary | null {
  if (!t || typeof t !== "object") return null;
  const obj = t as { chain?: Chain; run?: { url?: string } };
  const chain: Chain = Array.isArray(obj.chain) ? obj.chain : [];
  const stage = (name: string) => chain.find((s) => s.stage === name) as Record<string, unknown> | undefined;
  const approval = stage("approval"), agent = stage("agent"), ver = stage("verification"), pr = stage("pull_request");

  const models = Array.isArray(agent?.models_used) ? (agent!.models_used as string[]) : [];
  const main = models.find((m) => !/haiku/i.test(m)) ?? models[0] ?? (agent?.model_requested as string | undefined);
  const checks = Array.isArray(ver?.checks)
    ? (ver!.checks as Array<{ check: string; baseline_exit: number | null; after_exit: number | null }>).map((c) => ({
        name: String(c.check), beforePass: c.baseline_exit === 0, afterPass: c.after_exit === null ? null : c.after_exit === 0,
      }))
    : undefined;

  return {
    approver: typeof approval?.approved_by === "string" ? approval.approved_by : undefined,
    model: main || undefined,
    cost: typeof agent?.cost_usd === "number" ? agent.cost_usd : undefined,
    turns: typeof agent?.turns === "number" ? agent.turns : undefined,
    agentOutcome: typeof agent?.outcome === "string" ? agent.outcome : undefined,
    error: typeof agent?.error === "string" ? agent.error : undefined,
    checks,
    introduced: Array.isArray(ver?.introduced_failures) ? (ver!.introduced_failures as string[]) : undefined,
    files: Array.isArray(pr?.files_changed) ? (pr!.files_changed as unknown[]).length : undefined,
    runUrl: obj.run?.url,
  };
}

export interface Totals {
  counts: Record<Stage, number>;
  /** Sum of agent cost for items with a trace updated within the window */
  spentUsd: number;
  windowDays: number;
}

export function computeTotals(items: Item[], nowMs: number, windowDays = 30): Totals {
  const counts: Record<Stage, number> = { need: 0, run: 0, review: 0, fail: 0, done: 0, rejected: 0 };
  let spent = 0;
  const cutoff = nowMs - windowDays * 86_400_000;
  for (const i of items) {
    counts[i.stage]++;
    if (i.trace?.cost !== undefined && Date.parse(i.at) >= cutoff) spent += i.trace.cost;
  }
  return { counts, spentUsd: Math.round(spent * 10_000) / 10_000, windowDays };
}
