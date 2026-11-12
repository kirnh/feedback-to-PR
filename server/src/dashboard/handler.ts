import { checkPassphrase, hasValidSession, loginAllowed, makeSession, recordLoginFailure, setCookie } from "./auth";
import { isProblem, readEvents, readFeedbackFailures, type ApprovalEvent } from "./events";
import { mintBetaCode, verifyBetaCode } from "../feedback/beta";
import { parseProjects } from "../feedback/handler";
import { daysLeft, makeReader, type GhReader } from "./github";
import {
  buildItems, computeTotals, parseTraceFromComments,
  type GhIssue, type GhPr, type GhRun, type Item, type TraceSummary,
} from "./model";

export interface DashEnv {
  SIGNING_KEY: string;
  GITHUB_TOKEN: string;
  ALLOWED_REPOS: string;
  /** Salted hash of the owner's passphrase (set with: node scripts/secrets.mjs set WORKER_DASHBOARD_PASS) */
  DASHBOARD_PASS?: string;
  /** JSON map of project id to { repo, name }; the apps that can receive feedback */
  PROJECTS?: string;
  NTFY_PROGRESS_TOPIC?: string;
  VAPID_PRIVATE_JWK?: string;
  USED: KVNamespace;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface Problem { level: "error" | "warn"; text: string }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const err = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  json(status, { error: { code, message } }, headers);

const CACHE_KEY = "dash:cache";
const CACHE_SECONDS = 45;
const MAX_TRACE_LOOKUPS = 15;

const PERMISSION_HINT: Record<string, string> = {
  pulls: "Add the token permission 'Pull requests: Read'.",
  runs: "Add the token permission 'Actions: Read'.",
  issues: "The token needs 'Issues: Read'.",
};

export interface Sources { issues: boolean; pulls: boolean; runs: boolean }

async function loadRepo(repo: string, gh: GhReader, problems: Problem[]): Promise<{ items: Item[]; sources: Sources }> {
  const [triaged, approved, prs, runs] = await Promise.all([
    gh.get<GhIssue[]>(`/repos/${repo}/issues?state=all&labels=ai-triaged&per_page=30&sort=updated`),
    gh.get<GhIssue[]>(`/repos/${repo}/issues?state=all&labels=ai-fix&per_page=30&sort=updated`),
    gh.get<GhPr[]>(`/repos/${repo}/pulls?state=all&per_page=30&sort=updated&direction=desc`),
    gh.get<{ workflow_runs: GhRun[] }>(`/repos/${repo}/actions/workflows/ai-fix.yml/runs?per_page=30`),
  ]);

  const fail = (what: "issues" | "pulls" | "runs", r: Extract<typeof triaged | typeof prs | typeof runs, { ok: false }>) =>
    problems.push({ level: what === "issues" ? "error" : "warn", text: `${repo}: GitHub refused to list ${what === "runs" ? "workflow runs" : what} (${r.status}${r.message ? `: ${r.message}` : ""}). ${PERMISSION_HINT[what]}` });

  for (const [what, r] of [["issues", triaged], ["issues", approved], ["pulls", prs], ["runs", runs]] as const)
    if (!r.ok) console.log(JSON.stringify({ dashboard: "github_read_failed", repo, what, status: r.status, message: r.message }));
  if (!triaged.ok) fail("issues", triaged);
  if (!approved.ok) fail("issues", approved);
  if (!prs.ok) fail("pulls", prs);
  if (!runs.ok) fail("runs", runs);

  const byNumber = new Map<number, GhIssue>();
  for (const list of [triaged, approved]) if (list.ok) for (const i of list.data) byNumber.set(i.number, i);
  const issues = [...byNumber.values()];

  // Exact traces from the newest comments of approved issues (bounded to keep API use small).
  const traces = new Map<number, TraceSummary>();
  const candidates = issues.filter((i) => i.comments > 0 && !i.pull_request).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, MAX_TRACE_LOOKUPS);
  const comments = await Promise.all(candidates.map((i) => gh.get<Array<{ body?: string | null; created_at: string }>>(`/repos/${repo}/issues/${i.number}/comments?per_page=100`)));
  comments.forEach((c, idx) => {
    if (!c.ok) return;
    const t = parseTraceFromComments(c.data);
    if (t) traces.set(candidates[idx].number, t);
  });

  return {
    items: buildItems(repo, issues, prs.ok ? prs.data : [], runs.ok ? runs.data.workflow_runs : [], traces, { pulls: prs.ok, runs: runs.ok }),
    sources: { issues: triaged.ok && approved.ok, pulls: prs.ok, runs: runs.ok },
  };
}

export async function buildPayload(env: DashEnv, doFetch: Fetcher, nowMs: number) {
  const gh = makeReader(env.GITHUB_TOKEN, doFetch);
  const repos = env.ALLOWED_REPOS.split(",").map((s) => s.trim()).filter(Boolean);
  const problems: Problem[] = [];

  const perRepo = await Promise.all(repos.map((r) => loadRepo(r, gh, problems)));
  const items = perRepo.flatMap((r) => r.items);
  const sources: Sources = { issues: perRepo.every((r) => r.sources.issues), pulls: perRepo.every((r) => r.sources.pulls), runs: perRepo.every((r) => r.sources.runs) };
  const totals = computeTotals(items, nowMs);

  const events = await readEvents(env.USED);
  const weekAgo = nowMs - 7 * 86_400_000;
  for (const e of events.filter((x) => isProblem(x) && Date.parse(x.t) >= weekAgo).slice(0, 5)) {
    problems.push({ level: "error", text: `Approval ${e.action ?? "tap"}${e.issue ? ` on #${e.issue}` : ""} failed at ${e.t.slice(0, 16).replace("T", " ")} UTC: ${e.message ?? e.code} (${e.status}).` });
  }

  for (const f of (await readFeedbackFailures(env.USED)).filter((x) => Date.parse(x.t) >= weekAgo).slice(0, 5)) {
    problems.push({ level: "error", text: `Feedback ${f.id} (${f.project}) could not be processed: ${f.failure}.` });
  }

  const left = daysLeft(gh.tokenExpiry(), nowMs);
  if (left !== null && left <= 3) {
    problems.push({ level: left < 0 ? "error" : "warn", text: left < 0 ? "The Worker's GitHub token has expired. Approvals will fail until it is renewed." : `The Worker's GitHub token expires in ${left} day${left === 1 ? "" : "s"}. Renew it before then.` });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    repos,
    projects: Object.entries(parseProjects(env.PROJECTS)).map(([id, p]) => ({ id, name: p.name, repo: p.repo })),
    items,
    totals,
    problems,
    activity: events.filter((e: ApprovalEvent) => e.status === 200).slice(0, 8),
    health: {
      sources,
      githubTokenDaysLeft: left,
      githubTokenExpires: gh.tokenExpiry(),
      progressNotifications: !!env.NTFY_PROGRESS_TOPIC,
      webPushKey: !!env.VAPID_PRIVATE_JWK,
    },
  };
}

const clientId = (req: Request) => req.headers.get("cf-connecting-ip") ?? "unknown";

/** Routes: POST /v1/session, POST /v1/session/logout, GET /v1/dashboard. Null when the path is not ours. */
export async function handleDashboard(
  request: Request,
  env: DashEnv,
  doFetch: Fetcher = fetch,
  nowMs: number = Date.now(),
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const nowSec = Math.floor(nowMs / 1000);

  if (pathname === "/v1/session") {
    if (request.method !== "POST") return err(405, "method_not_allowed", "Use POST.");
    if (!env.DASHBOARD_PASS) return err(503, "not_configured", "No dashboard passphrase has been set yet.");
    const client = clientId(request);
    if (!(await loginAllowed(env.USED, client, nowMs))) return err(429, "too_many_attempts", "Too many wrong passphrases. Try again in 10 minutes.");
    let pass: unknown;
    try { pass = ((await request.json()) as { passphrase?: unknown }).passphrase; } catch { return err(400, "bad_request", "Send JSON: {\"passphrase\": \"...\"}."); }
    if (!(await checkPassphrase(pass, env.DASHBOARD_PASS))) {
      await recordLoginFailure(env.USED, client, nowMs);
      return err(401, "wrong_passphrase", "That passphrase is not right.");
    }
    return json(200, { ok: true }, { "set-cookie": setCookie(await makeSession(env.SIGNING_KEY, nowSec)) });
  }

  if (pathname === "/v1/session/logout") {
    if (request.method !== "POST") return err(405, "method_not_allowed", "Use POST.");
    return json(200, { ok: true }, { "set-cookie": setCookie("", 0) });
  }

  if (pathname === "/v1/dashboard") {
    if (request.method !== "GET") return err(405, "method_not_allowed", "Use GET.");
    if (!(await hasValidSession(request.headers.get("cookie"), env.SIGNING_KEY, nowSec))) return err(401, "login_required", "Sign in first.");

    const forceFresh = new URL(request.url).searchParams.get("fresh") === "1";
    if (!forceFresh) {
      const cached = await env.USED.get(CACHE_KEY);
      if (cached) {
        const { at, payload } = JSON.parse(cached) as { at: number; payload: unknown };
        if (nowMs - at < CACHE_SECONDS * 1000) return json(200, payload);
      }
    }
    const payload = await buildPayload(env, doFetch, nowMs);
    await env.USED.put(CACHE_KEY, JSON.stringify({ at: nowMs, payload }), { expirationTtl: 60 });
    return json(200, payload);
  }

  if (pathname === "/v1/beta-codes" || pathname === "/v1/beta-codes/revoke") {
    if (request.method !== "POST") return err(405, "method_not_allowed", "Use POST.");
    if (!(await hasValidSession(request.headers.get("cookie"), env.SIGNING_KEY, nowSec))) return err(401, "login_required", "Sign in first.");
    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; } catch { return err(400, "bad_request", "Send JSON."); }

    if (pathname === "/v1/beta-codes") {
      const project = typeof body.project === "string" ? body.project : "";
      const tester = typeof body.tester === "string" ? body.tester.trim() : "";
      const days = body.days === undefined ? 30 : Number(body.days);
      if (!parseProjects(env.PROJECTS)[project]) return err(400, "unknown_project", "That project is not set up for feedback.");
      if (!/^[\w .-]{1,40}$/.test(tester)) return err(400, "bad_tester", "Give the tester a short label (letters, numbers, spaces).");
      if (!Number.isInteger(days) || days < 1 || days > 90) return err(400, "bad_days", "Days must be 1 to 90.");
      const exp = nowSec + days * 86_400;
      const nonce = [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const code = await mintBetaCode({ p: project, t: tester, e: exp, n: nonce }, env.SIGNING_KEY);
      return json(200, { code, project, tester, expiresAt: new Date(exp * 1000).toISOString() });
    }

    const code = typeof body.code === "string" ? body.code.trim() : "";
    const v = await verifyBetaCode(code, env.SIGNING_KEY, nowSec);
    if (!v.ok) return err(400, "invalid_code", v.reason === "expired" ? "That code has already expired, so it cannot be used." : "That is not a valid beta code.");
    await env.USED.put(`beta:revoked:${v.payload.n}`, "1", { expirationTtl: Math.max(60, v.payload.e - nowSec + 3600) });
    return json(200, { ok: true });
  }

  return null;
}
