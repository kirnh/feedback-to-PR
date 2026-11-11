import { beforeEach, describe, expect, it } from "vitest";
import { handleApprove, type Env } from "../src/approve";
import { sign, type ApprovalPayload } from "../src/token";

const NOW = 1_800_000_000;
const KEY = "test-signing-key-0123456789";

const fakeKV = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace;
};

type Call = { url: string; method: string; body?: unknown };

function setup(issue: { state?: string; labels?: string[] } = {}, opts: { failOn?: string } = {}) {
  const calls: Call[] = [];
  const state = issue.state ?? "open";
  const labels = (issue.labels ?? ["ai-triaged"]).map((name) => ({ name }));
  const ghFetch = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (opts.failOn && `${method} ${url}`.includes(opts.failOn)) return new Response("{}", { status: 500 });
    if (method === "GET") return new Response(JSON.stringify({ state, labels }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const env: Env = { SIGNING_KEY: KEY, GITHUB_TOKEN: "ghp_x", ALLOWED_REPOS: "kirnh/MediSync", USED: fakeKV() };
  return { env, calls, ghFetch };
}

const payload = (over: Partial<ApprovalPayload> = {}): ApprovalPayload => ({
  r: "kirnh/MediSync", i: 1, a: "approve", e: NOW + 600, n: "nonce-aaaa-1111", ...over,
});
const req = async (p: ApprovalPayload, method = "POST") =>
  new Request(`https://w.example/v1/approve?t=${encodeURIComponent(await sign(p, KEY))}`, { method });

let ctx: ReturnType<typeof setup>;
beforeEach(() => { ctx = setup(); });

describe("POST /v1/approve", () => {
  it("approve: adds the ai-fix label and leaves an audit comment", async () => {
    const res = await handleApprove(await req(payload()), ctx.env, NOW, ctx.ghFetch);
    expect(res.status).toBe(200);
    const label = ctx.calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/1/labels"));
    expect(label?.body).toEqual({ labels: ["ai-fix"] });
    expect(ctx.calls.some((c) => c.url.endsWith("/issues/1/comments"))).toBe(true);
  });

  it("reject: closes the issue as not planned and adds no label", async () => {
    const res = await handleApprove(await req(payload({ a: "reject" })), ctx.env, NOW, ctx.ghFetch);
    expect(res.status).toBe(200);
    expect(ctx.calls.find((c) => c.method === "PATCH")?.body).toEqual({ state: "closed", state_reason: "not_planned" });
    expect(ctx.calls.some((c) => c.url.endsWith("/labels"))).toBe(false);
  });

  it("a link works once: the second use is refused and does nothing", async () => {
    await handleApprove(await req(payload()), ctx.env, NOW, ctx.ghFetch);
    const before = ctx.calls.length;
    const res = await handleApprove(await req(payload()), ctx.env, NOW, ctx.ghFetch);
    expect(res.status).toBe(409);
    expect(ctx.calls.length).toBe(before);
  });

  it("GET (link previews, scanners) does nothing", async () => {
    const res = await handleApprove(await req(payload(), "GET"), ctx.env, NOW, ctx.ghFetch);
    expect(res.status).toBe(405);
    expect(ctx.calls).toHaveLength(0);
  });

  it("expired link: 410 and no GitHub calls", async () => {
    const res = await handleApprove(await req(payload({ e: NOW - 5 })), ctx.env, NOW, ctx.ghFetch);
    expect(res.status).toBe(410);
    expect(ctx.calls).toHaveLength(0);
  });

  it("forged link: 401 and no GitHub calls", async () => {
    const forged = new Request(`https://w.example/v1/approve?t=${await sign(payload(), "wrong-key")}`, { method: "POST" });
    const res = await handleApprove(forged, ctx.env, NOW, ctx.ghFetch);
    expect(res.status).toBe(401);
    expect(ctx.calls).toHaveLength(0);
  });

  it("missing token: 400", async () => {
    const res = await handleApprove(new Request("https://w.example/v1/approve", { method: "POST" }), ctx.env, NOW, ctx.ghFetch);
    expect(res.status).toBe(400);
  });

  it("repo outside the allowlist: 403 even with a valid signature", async () => {
    const res = await handleApprove(await req(payload({ r: "someone/else" })), ctx.env, NOW, ctx.ghFetch);
    expect(res.status).toBe(403);
    expect(ctx.calls).toHaveLength(0);
  });

  it.each([
    ["closed issue", { state: "closed" }, "not_open"],
    ["issue without ai-triaged", { labels: [] }, "not_triaged"],
    ["issue already approved", { labels: ["ai-triaged", "ai-fix"] }, "already_approved"],
  ])("refuses a %s", async (_n, issue, code) => {
    const c = setup(issue);
    const res = await handleApprove(await req(payload()), c.env, NOW, c.ghFetch);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code } });
    expect(c.calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("GitHub failure: 502, and the link is NOT consumed so it can be retried", async () => {
    const c = setup({}, { failOn: "POST https://api.github.com/repos/kirnh/MediSync/issues/1/labels" });
    const res = await handleApprove(await req(payload()), c.env, NOW, c.ghFetch);
    expect(res.status).toBe(502);
    const retry = setup();
    retry.env.USED = c.env.USED;
    expect((await handleApprove(await req(payload()), retry.env, NOW, retry.ghFetch)).status).toBe(200);
  });

  it("never sends the GitHub token anywhere but api.github.com", async () => {
    await handleApprove(await req(payload()), ctx.env, NOW, ctx.ghFetch);
    expect(ctx.calls.every((c) => c.url.startsWith("https://api.github.com/"))).toBe(true);
  });
});
