import { recordFeedbackFailure, type Kv } from "../dashboard/events";
import { verifyBetaCode, type BetaPayload } from "./beta";
import { makeLlm, type LlmEnv } from "./llm";
import { cleanText } from "./sanitize";
import { triage, type TriageResult } from "./triage";

export interface FeedbackEnv extends LlmEnv {
  SIGNING_KEY: string;
  GITHUB_TOKEN: string;
  ALLOWED_REPOS: string;
  /** JSON: { "<project id>": { "repo": "owner/name", "name": "Display name" } } */
  PROJECTS?: string;
  USED: Kv;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Ctx = { waitUntil(p: Promise<unknown>): void };

export type FeedbackStatus = "received" | "triaged" | "duplicate" | "rejected" | "failed";
export interface FeedbackRecord { id: string; status: FeedbackStatus; project: string; reporter: string; at: string; failure?: string }

const CONTEXT_KEYS = ["app_version", "platform", "os", "device", "screen", "locale"] as const;
const PER_TESTER_PER_HOUR = 10;
const PER_PROJECT_PER_DAY = 200;
const MAX_BODY = 8192;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

export function parseProjects(raw: string | undefined): Record<string, { repo: string; name: string }> {
  try {
    const o = JSON.parse(raw ?? "{}") as Record<string, { repo?: unknown; name?: unknown }>;
    const out: Record<string, { repo: string; name: string }> = {};
    for (const [id, p] of Object.entries(o)) if (typeof p?.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(p.repo)) out[id] = { repo: p.repo, name: typeof p.name === "string" ? p.name : id };
    return out;
  } catch {
    return {};
  }
}

async function sha(text: string, len: number): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

/** Counts events in a window. Returns false once the limit is reached. */
async function underLimit(kv: Kv, key: string, limit: number, ttlSeconds: number): Promise<boolean> {
  const n = Number((await kv.get(key)) ?? 0);
  if (n >= limit) return false;
  await kv.put(key, String(n + 1), { expirationTtl: ttlSeconds });
  return true;
}

function gh(env: FeedbackEnv, doFetch: Fetcher, path: string, init: RequestInit = {}) {
  return doFetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "feedback-to-pr-intake", ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

export function issueBody(r: TriageResult, context: Record<string, string>, trace: Record<string, unknown>): string {
  const ctxLine = CONTEXT_KEYS.filter((k) => context[k]).map((k) => `${k.replace("_", " ")}: ${context[k]}`).join(" · ");
  return [
    `**Type:** ${r.type}${r.severity ? ` · **Severity:** ${r.severity}` : ""}${r.area ? ` · **Area:** ${r.area}` : ""}`,
    "",
    r.body,
    "",
    ctxLine ? `**Context:** ${ctxLine}` : "",
    "_Reported by a beta tester through the in-app feedback section. The original message is not stored on GitHub._",
    "",
    // Machine-readable triage record; only fields we control, so "-->" cannot appear inside it.
    `<!-- f2pr-trace:triage ${JSON.stringify(trace)} -->`,
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

async function save(env: FeedbackEnv, rec: FeedbackRecord) {
  await env.USED.put(`fb:${rec.id}`, JSON.stringify(rec), { expirationTtl: 30 * 86_400 });
  if (rec.status === "failed") await recordFeedbackFailure(env.USED, { t: new Date().toISOString(), id: rec.id, project: rec.project, failure: rec.failure ?? "unknown" });
}

/** The background half: triage the message and act on GitHub. Never throws; failures become a status. */
async function process(env: FeedbackEnv, doFetch: Fetcher, rec: FeedbackRecord, repo: string, projectName: string, message: string, context: Record<string, string>) {
  try {
    const llm = makeLlm(env, doFetch);
    if (!llm) return save(env, { ...rec, status: "failed", failure: "triage_not_configured" });

    const open = await gh(env, doFetch, `/repos/${repo}/issues?state=open&labels=ai-triaged&per_page=30`);
    if (!open.ok) return save(env, { ...rec, status: "failed", failure: `github_read_${open.status}` });
    const candidates = ((await open.json()) as Array<{ number: number; title: string; pull_request?: unknown }>).filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title }));

    const result = await triage(llm, { project: projectName, message, context, candidates });

    if (result.decision === "reject") return save(env, { ...rec, status: "rejected" });

    if (result.decision === "duplicate") {
      await gh(env, doFetch, `/repos/${repo}/issues/${result.duplicateOf}/comments`, {
        method: "POST", body: JSON.stringify({ body: "Another beta tester reported the same thing." }),
      });
      return save(env, { ...rec, status: "duplicate" });
    }

    const created = await gh(env, doFetch, `/repos/${repo}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: result.title,
        body: issueBody(result, context, { source: "intake", decision: "create", model: env.TRIAGE_MODEL ?? "default", provider: env.TRIAGE_PROVIDER ?? "anthropic", reporter: rec.reporter, at: rec.at }),
        labels: ["ai-triaged"],
      }),
    });
    if (!created.ok) return save(env, { ...rec, status: "failed", failure: `github_create_${created.status}` });
    return save(env, { ...rec, status: "triaged" });
  } catch (e) {
    return save(env, { ...rec, status: "failed", failure: e instanceof Error ? e.message.slice(0, 80) : "unknown" });
  }
}

async function authenticate(request: Request, env: FeedbackEnv, nowSec: number): Promise<{ ok: true; payload: BetaPayload; repo: string; name: string } | { ok: false; res: Response }> {
  const code = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!code) return { ok: false, res: err(401, "missing_code", "Send your beta code as a Bearer token.") };
  const v = await verifyBetaCode(code, env.SIGNING_KEY, nowSec);
  if (!v.ok) return { ok: false, res: v.reason === "expired" ? err(401, "expired", "This beta code has expired. Ask the app owner for a new one.") : err(401, "invalid_code", "This beta code is not valid.") };
  if (await env.USED.get(`beta:revoked:${v.payload.n}`)) return { ok: false, res: err(401, "revoked", "This beta code was revoked.") };
  const project = parseProjects(env.PROJECTS)[v.payload.p];
  const allowed = env.ALLOWED_REPOS.split(",").map((s) => s.trim());
  if (!project || !allowed.includes(project.repo)) return { ok: false, res: err(401, "unknown_project", "This beta code is for a project this service does not know.") };
  return { ok: true, payload: v.payload, repo: project.repo, name: project.name };
}

/** POST /v1/feedback and GET /v1/feedback/{id}. Null when the path is not ours. */
export async function handleFeedback(request: Request, env: FeedbackEnv, ctx: Ctx, doFetch: Fetcher = fetch, nowMs: number = Date.now()): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const nowSec = Math.floor(nowMs / 1000);

  const m = /^\/v1\/feedback\/(fb_[0-9a-f]{12})$/.exec(pathname);
  if (m) {
    if (request.method !== "GET") return err(405, "method_not_allowed", "Use GET.");
    const auth = await authenticate(request, env, nowSec);
    if (!auth.ok) return auth.res;
    const raw = await env.USED.get(`fb:${m[1]}`);
    const rec = raw ? (JSON.parse(raw) as FeedbackRecord) : null;
    // Only the tester who sent it may read it; anyone else gets the same answer as for an unknown id.
    if (!rec || rec.project !== auth.payload.p || rec.reporter !== (await sha(auth.payload.n, 8))) return err(404, "not_found", "No such feedback.");
    // A message still "received" after 5 minutes was lost (for example the Worker restarted): say so honestly.
    const stale = rec.status === "received" && nowMs - Date.parse(rec.at) > 5 * 60_000;
    return json(200, { id: rec.id, status: stale ? "failed" : rec.status });
  }

  if (pathname !== "/v1/feedback") return null;
  if (request.method !== "POST") return err(405, "method_not_allowed", "Use POST.");

  const auth = await authenticate(request, env, nowSec);
  if (!auth.ok) return auth.res;
  const { payload, repo, name } = auth;

  const text = await request.text();
  if (text.length > MAX_BODY) return err(400, "too_large", "That message is too large.");
  let body: { message?: unknown; context?: unknown };
  try { body = JSON.parse(text); } catch { return err(400, "bad_json", "Send JSON."); }
  const message = typeof body.message === "string" ? cleanText(body.message, 2000) : "";
  if (!message) return err(400, "empty_message", "Write a message first.");
  const context: Record<string, string> = {};
  if (body.context && typeof body.context === "object") {
    for (const k of CONTEXT_KEYS) {
      const v = (body.context as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) context[k] = cleanText(v, 80).replace(/\s+/g, " ");
    }
  }

  const idem = request.headers.get("idempotency-key");
  if (idem && idem.length <= 64) {
    const prior = await env.USED.get(`idem:${payload.p}:${await sha(idem, 24)}`);
    if (prior) return json(202, { id: prior, status: "received" });
  }

  const hour = Math.floor(nowSec / 3600), day = Math.floor(nowSec / 86400);
  if (!(await underLimit(env.USED, `rl:fb:t:${payload.n}:${hour}`, PER_TESTER_PER_HOUR, 3700))) return err(429, "slow_down", "You have sent a lot of feedback in the last hour. Please try again later.");
  if (!(await underLimit(env.USED, `rl:fb:p:${payload.p}:${day}`, PER_PROJECT_PER_DAY, 90_000))) return err(429, "project_limit", "This app has reached today's feedback limit.");

  const id = `fb_${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const rec: FeedbackRecord = { id, status: "received", project: payload.p, reporter: await sha(payload.n, 8), at: new Date(nowMs).toISOString() };
  await save(env, rec);
  if (idem && idem.length <= 64) await env.USED.put(`idem:${payload.p}:${await sha(idem, 24)}`, id, { expirationTtl: 86_400 });

  ctx.waitUntil(process(env, doFetch, rec, repo, name, message, context));
  return json(202, { id, status: "received" });
}
