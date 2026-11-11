import { verify } from "./token";

export interface Env {
  /** HMAC key shared with the workflow that mints approval links */
  SIGNING_KEY: string;
  /** Fine-grained GitHub token (Issues: read/write). Never leaves this Worker. */
  GITHUB_TOKEN: string;
  /** Comma-separated owner/repo allowlist */
  ALLOWED_REPOS: string;
  /** Records used nonces so a link works once */
  USED: KVNamespace;
}

type GhFetch = (url: string, init?: RequestInit) => Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fail = (status: number, code: string, message: string) => json(status, { error: { code, message } });

function gh(env: Env, ghFetch: GhFetch, path: string, init: RequestInit = {}) {
  return ghFetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "feedback-to-pr-approval",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

/**
 * POST /v1/approve?t=<token>
 * Approve adds the `ai-fix` label to a triaged, open issue. Reject closes it as not planned.
 * POST only: link scanners and previews issue GET requests and must never trigger an action.
 */
export async function handleApprove(
  request: Request,
  env: Env,
  nowSec: number = Math.floor(Date.now() / 1000),
  ghFetch: GhFetch = fetch,
): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const token = new URL(request.url).searchParams.get("t");
  if (!token) return fail(400, "missing_token", "Missing token.");

  const v = await verify(token, env.SIGNING_KEY, nowSec);
  if (!v.ok) {
    if (v.reason === "expired") return fail(410, "expired", "This link has expired.");
    return fail(v.reason === "malformed" ? 400 : 401, v.reason, "Invalid token.");
  }
  const { r: repo, i: issue, a: action, n: nonce, e: exp } = v.payload;

  const allowed = env.ALLOWED_REPOS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(repo)) return fail(403, "repo_not_allowed", "Repository not allowed.");

  if (await env.USED.get(nonce)) return fail(409, "already_used", "This link was already used.");

  // The issue must still be an open, triaged candidate that has not been approved yet.
  const res = await gh(env, ghFetch, `/repos/${repo}/issues/${issue}`);
  if (!res.ok) return fail(502, "github_error", `GitHub returned ${res.status} reading the issue.`);
  const data = (await res.json()) as { state: string; labels: Array<{ name: string } | string> };
  const labels = data.labels.map((l) => (typeof l === "string" ? l : l.name));
  if (data.state !== "open") return fail(409, "not_open", "The issue is not open.");
  if (!labels.includes("ai-triaged")) return fail(409, "not_triaged", "The issue is not marked ai-triaged.");
  if (labels.includes("ai-fix")) return fail(409, "already_approved", "The issue is already approved.");

  if (action === "approve") {
    const r = await gh(env, ghFetch, `/repos/${repo}/issues/${issue}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: ["ai-fix"] }),
    });
    if (!r.ok) return fail(502, "github_error", `GitHub returned ${r.status} adding the label.`);
  } else {
    const r = await gh(env, ghFetch, `/repos/${repo}/issues/${issue}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
    });
    if (!r.ok) return fail(502, "github_error", `GitHub returned ${r.status} closing the issue.`);
  }

  // Leave an audit note on the issue (best effort; the action itself already succeeded).
  await gh(env, ghFetch, `/repos/${repo}/issues/${issue}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body: `${action === "approve" ? "Approved" : "Rejected"} with a one-tap link (link id \`${nonce.slice(0, 8)}\`).`,
    }),
  }).catch(() => undefined);

  await env.USED.put(nonce, "1", { expirationTtl: Math.max(60, exp - nowSec + 3600) });
  return json(200, { ok: true, action, repo, issue });
}
