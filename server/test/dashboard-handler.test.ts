import { beforeEach, describe, expect, it } from "vitest";
import { handleApprove, type Env as ApproveEnv } from "../src/approve";
import { storedPassphrase } from "../src/dashboard/auth";
import { readEvents } from "../src/dashboard/events";
import { handleDashboard, type DashEnv } from "../src/dashboard/handler";
import { sign } from "../src/token";

const NOW = Date.parse("2026-11-11T06:00:00Z");
const KEY = "signing-key-for-tests-0123456789";

const makeKv = () => { const m = new Map<string, string>(); return { map: m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) }; };

interface FakeOpts { denyPulls?: boolean; denyRuns?: boolean; expiry?: string; trace?: boolean }
function fakeGithub(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const traceJson = JSON.stringify({ chain: [{ stage: "approval", approved_by: "kirnh" }, { stage: "agent", models_used: ["claude-sonnet-5-5"], turns: 9, cost_usd: 0.1 }, { stage: "verification", checks: [], introduced_failures: [] }, { stage: "pull_request", files_changed: ["a"] }] });
  const fn = async (url: string) => {
    calls.push(url);
    const path = url.replace("https://api.github.com", "");
    const headers: Record<string, string> = opts.expiry ? { "github-authentication-token-expiration": opts.expiry } : {};
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers });
    const no = (status: number) => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status, headers });
    if (path.includes("/issues?") && path.includes("labels=ai-triaged")) return ok([
      { number: 3, title: "Add tests", state: "open", labels: [{ name: "ai-triaged" }], html_url: "https://github.com/o/r/issues/3", created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:00:00Z", comments: 0 },
      { number: 2, title: "Fix unit", state: "open", labels: [{ name: "ai-triaged" }, { name: "ai-fix" }], html_url: "https://github.com/o/r/issues/2", created_at: "2026-11-09T00:00:00Z", updated_at: "2026-11-10T03:00:00Z", comments: 2 },
    ]);
    if (path.includes("/issues?") && path.includes("labels=ai-fix")) return ok([
      { number: 2, title: "Fix unit", state: "open", labels: [{ name: "ai-triaged" }, { name: "ai-fix" }], html_url: "https://github.com/o/r/issues/2", created_at: "2026-11-09T00:00:00Z", updated_at: "2026-11-10T03:00:00Z", comments: 2 },
    ]);
    if (path.includes("/pulls?")) return opts.denyPulls ? no(403) : ok([{ number: 8, state: "open", draft: true, merged_at: null, html_url: "https://github.com/o/r/pull/8", head: { ref: "ai/issue-2" }, created_at: "2026-11-10T04:00:00Z" }]);
    if (path.includes("/actions/workflows/")) return opts.denyRuns ? no(403) : ok({ workflow_runs: [{ id: 77, display_title: "AI fix #2", status: "completed", conclusion: "success", html_url: "https://github.com/o/r/actions/runs/77", created_at: "2026-11-10T03:30:00Z" }] });
    if (path.includes("/issues/2/comments")) return ok([{ body: opts.trace === false ? "hi" : `### Judgement trace\n<!-- f2pr-trace ${traceJson} -->`, created_at: "2026-11-10T05:00:00Z" }]);
    return no(404);
  };
  return { fn, calls };
}

let kv: ReturnType<typeof makeKv>;
let env: DashEnv;
beforeEach(async () => {
  kv = makeKv();
  env = { SIGNING_KEY: KEY, GITHUB_TOKEN: "t", ALLOWED_REPOS: "o/r", USED: kv as unknown as KVNamespace, DASHBOARD_PASS: await storedPassphrase("open sesame now") };
});

const login = (pass: string, ip = "9.9.9.9") =>
  new Request("https://w.example/v1/session", { method: "POST", body: JSON.stringify({ passphrase: pass }), headers: { "cf-connecting-ip": ip } });
async function cookieAfterLogin(): Promise<string> {
  const res = await handleDashboard(login("open sesame now"), env, undefined, NOW);
  return res!.headers.get("set-cookie")!.split(";")[0];
}
const get = (cookie?: string, q = "") => new Request(`https://w.example/v1/dashboard${q}`, { headers: cookie ? { cookie } : {} });

describe("login", () => {
  it("right passphrase: 200 and an HttpOnly session cookie", async () => {
    const res = await handleDashboard(login("open sesame now"), env, undefined, NOW);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("set-cookie")).toMatch(/f2pr_session=.+HttpOnly/);
  });
  it("wrong passphrase: 401 and no cookie", async () => {
    const res = await handleDashboard(login("nope"), env, undefined, NOW);
    expect(res!.status).toBe(401);
    expect(res!.headers.get("set-cookie")).toBeNull();
  });
  it("locks out after 5 wrong tries, even if the 6th is right", async () => {
    for (let i = 0; i < 5; i++) await handleDashboard(login("wrong"), env, undefined, NOW);
    expect((await handleDashboard(login("open sesame now"), env, undefined, NOW))!.status).toBe(429);
    expect((await handleDashboard(login("open sesame now", "1.1.1.1"), env, undefined, NOW))!.status).toBe(200); // another client is unaffected
  });
  it("503 with a clear message when no passphrase has been set", async () => {
    const res = await handleDashboard(login("x"), { ...env, DASHBOARD_PASS: undefined }, undefined, NOW);
    expect(res!.status).toBe(503);
  });
  it("rejects bad JSON and wrong methods", async () => {
    expect((await handleDashboard(new Request("https://w.example/v1/session", { method: "POST", body: "{" }), env, undefined, NOW))!.status).toBe(400);
    expect((await handleDashboard(new Request("https://w.example/v1/session"), env, undefined, NOW))!.status).toBe(405);
  });
  it("logout clears the cookie", async () => {
    const res = await handleDashboard(new Request("https://w.example/v1/session/logout", { method: "POST" }), env, undefined, NOW);
    expect(res!.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("GET /v1/dashboard", () => {
  it("401 without a session and makes no GitHub calls", async () => {
    const gh = fakeGithub();
    const res = await handleDashboard(get(), env, gh.fn, NOW);
    expect(res!.status).toBe(401);
    expect(gh.calls).toHaveLength(0);
  });
  it("401 with a forged cookie", async () => {
    expect((await handleDashboard(get("f2pr_session=abc.def"), env, fakeGithub().fn, NOW))!.status).toBe(401);
  });

  it("builds items by stage with cost and approver from the embedded trace", async () => {
    const res = await handleDashboard(get(await cookieAfterLogin()), env, fakeGithub().fn, NOW);
    const body = (await res!.json()) as { items: Array<{ issue: number; stage: string; trace?: { cost: number; approver: string } }>; totals: { counts: Record<string, number>; spentUsd: number }; problems: unknown[] };
    expect(res!.status).toBe(200);
    expect(body.items.map((i) => [i.issue, i.stage])).toEqual([[3, "need"], [2, "review"]]);
    expect(body.items[1].trace).toMatchObject({ cost: 0.1, approver: "kirnh" });
    expect(body.totals.counts).toMatchObject({ need: 1, review: 1 });
    expect(body.totals.spentUsd).toBe(0.1);
    expect(body.problems).toEqual([]);
  });

  it("a missing permission becomes a clear problem and the rest still loads", async () => {
    const res = await handleDashboard(get(await cookieAfterLogin()), env, fakeGithub({ denyPulls: true, denyRuns: true }).fn, NOW);
    const body = (await res!.json()) as { items: Array<{ issue: number; stage: string }>; problems: Array<{ text: string }> };
    expect(res!.status).toBe(200);
    expect(body.items.map((i) => i.issue).sort()).toEqual([2, 3]);
    expect(body.problems.map((p) => p.text).join("\n")).toContain("Pull requests: Read");
    expect(body.problems.map((p) => p.text).join("\n")).toContain("Actions: Read");
  });

  it("warns when the GitHub token is about to expire, and errors when it has", async () => {
    const soon = await handleDashboard(get(await cookieAfterLogin(), "?fresh=1"), env, fakeGithub({ expiry: "2026-11-13 06:00:00 UTC" }).fn, NOW);
    expect(JSON.stringify(await soon!.json())).toContain("expires in 2 days");
    const gone = await handleDashboard(get(await cookieAfterLogin(), "?fresh=1"), env, fakeGithub({ expiry: "2026-11-10 06:00:00 UTC" }).fn, NOW);
    expect(JSON.stringify(await gone!.json())).toContain("has expired");
  });

  it("serves from cache for 45 seconds, and ?fresh=1 bypasses it", async () => {
    const gh = fakeGithub();
    const cookie = await cookieAfterLogin();
    await handleDashboard(get(cookie), env, gh.fn, NOW);
    const first = gh.calls.length;
    await handleDashboard(get(cookie), env, gh.fn, NOW + 30_000);
    expect(gh.calls.length).toBe(first);
    await handleDashboard(get(cookie), env, gh.fn, NOW + 50_000);
    expect(gh.calls.length).toBeGreaterThan(first);
    const before = gh.calls.length;
    await handleDashboard(get(cookie, "?fresh=1"), env, gh.fn, NOW + 51_000);
    expect(gh.calls.length).toBeGreaterThan(before);
  });

  it("never exposes secrets or the token in the payload", async () => {
    const res = await handleDashboard(get(await cookieAfterLogin()), { ...env, GITHUB_TOKEN: "ghp_SECRET_TOKEN_VALUE" }, fakeGithub().fn, NOW);
    const text = JSON.stringify(await res!.json());
    for (const s of ["ghp_SECRET_TOKEN_VALUE", KEY, "pbkdf2"]) expect(text).not.toContain(s);
  });
});

describe("approval attempts are logged and surface as problems", () => {
  const approveEnv = (): ApproveEnv => ({ SIGNING_KEY: KEY, GITHUB_TOKEN: "t", ALLOWED_REPOS: "o/r", USED: kv as unknown as KVNamespace });
  const tapUrl = async (payload: Partial<{ r: string; i: number; a: "approve" | "reject"; e: number; n: string }> = {}) =>
    new Request(`https://w.example/v1/approve?t=${encodeURIComponent(await sign({ r: "o/r", i: 5, a: "approve", e: Math.floor(NOW / 1000) + 600, n: "nonce-aaaa-1111", ...payload }, KEY))}`, { method: "POST" });
  const ghDown = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });

  it("a failed tap is recorded with its reason and shown as a problem", async () => {
    await handleApprove(await tapUrl(), approveEnv(), Math.floor(NOW / 1000), ghDown);
    const events = await readEvents(kv);
    expect(events[0]).toMatchObject({ status: 502, code: "github_error", repo: "o/r", issue: 5, action: "approve" });
    const res = await handleDashboard(get(await cookieAfterLogin(), "?fresh=1"), env, fakeGithub().fn, NOW);
    expect(JSON.stringify(await res!.json())).toMatch(/Approval approve on #5 failed.*502/);
  });
  it("routine refusals (duplicate tap) are logged but not raised as problems", async () => {
    kv.map.set("nonce-aaaa-1111", "1");
    await handleApprove(await tapUrl(), approveEnv(), Math.floor(NOW / 1000), ghDown);
    expect((await readEvents(kv))[0]).toMatchObject({ status: 409, code: "already_used" });
    const res = await handleDashboard(get(await cookieAfterLogin(), "?fresh=1"), env, fakeGithub().fn, NOW);
    expect(((await res!.json()) as { problems: unknown[] }).problems).toEqual([]);
  });
  it("scanner hits (GET) and token-less calls are not logged", async () => {
    await handleApprove(new Request("https://w.example/v1/approve"), approveEnv(), Math.floor(NOW / 1000));
    await handleApprove(new Request("https://w.example/v1/approve", { method: "POST" }), approveEnv(), Math.floor(NOW / 1000));
    expect(await readEvents(kv)).toEqual([]);
  });
  it("the event log is capped", async () => {
    for (let i = 0; i < 70; i++) await handleApprove(await tapUrl({ n: `nonce-${String(i).padStart(8, "0")}` }), approveEnv(), Math.floor(NOW / 1000), ghDown);
    expect((await readEvents(kv)).length).toBe(60);
  });
});
