import { describe, expect, it } from "vitest";
import { handleApprove, type Env } from "../src/approve";
import { ackMessage, sendAck } from "../src/ntfy";
import { sign, type ApprovalPayload } from "../src/token";

const NOW = 1_800_000_000;
const KEY = "test-signing-key-0123456789";

describe("ackMessage", () => {
  it("approve: names the project and issue, plain text, low priority, emoji tag", () => {
    const m = ackMessage("kirnh/MediSync", 3, "approve", "topic-x");
    expect(m).toMatchObject({ topic: "topic-x", title: "[MediSync] #3 · Approved, starting", priority: 2, tags: ["white_check_mark"] });
    expect(m.click).toBe("https://github.com/kirnh/MediSync/issues/3");
    expect(m.message).not.toMatch(/[*_`]/); // iPhone shows markdown as raw symbols
  });

  it("reject: says the issue was closed and nothing started", () => {
    const m = ackMessage("kirnh/MediSync", 3, "reject", "t");
    expect(m.title).toBe("[MediSync] #3 · Rejected");
    expect(m.message).toContain("closed");
    expect(m.tags).toEqual(["no_entry_sign"]);
  });
});

describe("sendAck", () => {
  it("does nothing when no progress topic is configured", async () => {
    let called = false;
    const ok = await sendAck({}, "a/b", 1, "approve", async () => { called = true; return new Response("{}"); });
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  it("posts JSON to the configured server", async () => {
    const seen: { url?: string; body?: unknown } = {};
    const ok = await sendAck({ NTFY_PROGRESS_TOPIC: "prog", NTFY_SERVER: "https://ntfy.example" }, "a/b", 7, "approve", async (url, init) => {
      seen.url = url; seen.body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    });
    expect(ok).toBe(true);
    expect(seen.url).toBe("https://ntfy.example");
    expect(seen.body).toMatchObject({ topic: "prog" });
  });

  it("never throws when ntfy is down", async () => {
    expect(await sendAck({ NTFY_PROGRESS_TOPIC: "p" }, "a/b", 1, "approve", async () => { throw new Error("network"); })).toBe(false);
    expect(await sendAck({ NTFY_PROGRESS_TOPIC: "p" }, "a/b", 1, "approve", async () => new Response("no", { status: 500 }))).toBe(false);
  });
});

describe("handleApprove sends the acknowledgement", () => {
  const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace; };
  const gh = async (_u: string, init: RequestInit = {}) =>
    (init.method ?? "GET") === "GET"
      ? new Response(JSON.stringify({ state: "open", labels: [{ name: "ai-triaged" }] }), { status: 200 })
      : new Response("{}", { status: 200 });
  const payload = (a: "approve" | "reject"): ApprovalPayload => ({ r: "kirnh/MediSync", i: 3, a, e: NOW + 600, n: `nonce-${a}-123456` });
  const req = async (a: "approve" | "reject") =>
    new Request(`https://w.example/v1/approve?t=${encodeURIComponent(await sign(payload(a), KEY))}`, { method: "POST" });

  it("approve: the owner gets 'Approved, starting' and the response is still 200", async () => {
    const sent: unknown[] = [];
    const env: Env = { SIGNING_KEY: KEY, GITHUB_TOKEN: "x", ALLOWED_REPOS: "kirnh/MediSync", USED: kv(), NTFY_PROGRESS_TOPIC: "prog" };
    const res = await handleApprove(await req("approve"), env, NOW, gh, async (_u, init) => { sent.push(JSON.parse(String(init?.body))); return new Response("{}"); });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "[MediSync] #3 · Approved, starting" });
  });

  it("reject: the owner gets 'Rejected'", async () => {
    const sent: unknown[] = [];
    const env: Env = { SIGNING_KEY: KEY, GITHUB_TOKEN: "x", ALLOWED_REPOS: "kirnh/MediSync", USED: kv(), NTFY_PROGRESS_TOPIC: "prog" };
    await handleApprove(await req("reject"), env, NOW, gh, async (_u, init) => { sent.push(JSON.parse(String(init?.body))); return new Response("{}"); });
    expect(sent[0]).toMatchObject({ title: "[MediSync] #3 · Rejected" });
  });

  it("an ntfy outage does not fail an approval that already succeeded", async () => {
    const env: Env = { SIGNING_KEY: KEY, GITHUB_TOKEN: "x", ALLOWED_REPOS: "kirnh/MediSync", USED: kv(), NTFY_PROGRESS_TOPIC: "prog" };
    const res = await handleApprove(await req("approve"), env, NOW, gh, async () => { throw new Error("ntfy down"); });
    expect(res.status).toBe(200);
  });

  it("a refused approval sends no acknowledgement", async () => {
    const sent: unknown[] = [];
    const env: Env = { SIGNING_KEY: KEY, GITHUB_TOKEN: "x", ALLOWED_REPOS: "someone/else", USED: kv(), NTFY_PROGRESS_TOPIC: "prog" };
    const res = await handleApprove(await req("approve"), env, NOW, gh, async (_u, init) => { sent.push(init); return new Response("{}"); });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
