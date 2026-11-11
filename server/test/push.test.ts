import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePush, isPushEndpoint, vapidFromJwk, type PushEnv } from "../src/push";
import { b64urlEncode } from "../src/token";

const kv = () => {
  const m = new Map<string, string>();
  return { map: m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) };
};

async function newVapidJwk() {
  const { privateKey } = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
}

/** A browser-style subscription: real P-256 key + 16-byte auth secret, so the encryption path really runs. */
async function newSubscription(endpoint = "https://web.push.apple.com/abc123") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { endpoint, keys: { p256dh: b64urlEncode(raw), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) } };
}

type Ctx = { jobs: Promise<unknown>[]; waitUntil(p: Promise<unknown>): void };
const makeCtx = (): Ctx => ({ jobs: [], waitUntil(p) { this.jobs.push(p); } });
const post = (path: string, body: unknown) =>
  new Request(`https://w.example${path}`, { method: "POST", body: JSON.stringify(body), headers: { "user-agent": "TestPhone/1.0" } });

let store: ReturnType<typeof kv>;
let env: PushEnv;
beforeEach(async () => {
  store = kv();
  env = { USED: store as unknown as KVNamespace, VAPID_PRIVATE_JWK: await newVapidJwk() };
});
afterEach(() => vi.useRealTimers());

describe("isPushEndpoint", () => {
  it.each([
    "https://web.push.apple.com/Qabc",
    "https://fcm.googleapis.com/fcm/send/xyz",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
  ])("accepts real push service %s", (u) => expect(isPushEndpoint(u)).toBe(true));

  it.each([
    "https://evil.example/push",
    "http://web.push.apple.com/x",
    "https://web.push.apple.com.evil.example/x",
    "https://evilpush.apple.com/x",
    "https://169.254.169.254/latest/meta-data",
    "not a url",
    "",
    42,
    undefined,
  ])("rejects %s", (u) => expect(isPushEndpoint(u as never)).toBe(false));
});

describe("vapidFromJwk", () => {
  it("derives a 65-byte uncompressed public key and the private scalar", async () => {
    const v = vapidFromJwk(await newVapidJwk());
    expect(v).not.toBeNull();
    expect(v!.publicKey).toHaveLength(87); // 65 bytes in unpadded base64url
    expect(v!.privateKey).toHaveLength(43); // 32 bytes
    expect(v!.subject).toMatch(/^https:\/\//);
  });
  it.each([undefined, "", "not json", "{}", JSON.stringify({ kty: "RSA" }), JSON.stringify({ kty: "EC", crv: "P-256", x: "a", y: "b" })])(
    "returns null for %s", (raw) => expect(vapidFromJwk(raw as never)).toBeNull());
});

describe("GET /v1/push/key", () => {
  it("returns the public key only (never the private part)", async () => {
    const res = await handlePush(new Request("https://w.example/v1/push/key"), env, makeCtx());
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, string>;
    expect(Object.keys(body)).toEqual(["publicKey"]);
    expect(JSON.stringify(body)).not.toContain(JSON.parse(env.VAPID_PRIVATE_JWK!).d);
  });
  it("503 when push is not configured", async () => {
    const res = await handlePush(new Request("https://w.example/v1/push/key"), { USED: env.USED }, makeCtx());
    expect(res!.status).toBe(503);
  });
  it("405 for POST; null for unrelated paths", async () => {
    expect((await handlePush(post("/v1/push/key", {}), env, makeCtx()))!.status).toBe(405);
    expect(await handlePush(new Request("https://w.example/v1/other"), env, makeCtx())).toBeNull();
  });
});

describe("POST /v1/push-test/report", () => {
  it("stores a known answer with a timestamp and user agent", async () => {
    const res = await handlePush(post("/v1/push-test/report", { k: "arrived_closed", v: "yes" }), env, makeCtx(), fetch, 1_800_000_000_000);
    expect(res!.status).toBe(200);
    expect(JSON.parse(store.map.get("pt:r:arrived_closed")!)).toMatchObject({ v: "yes", ua: "TestPhone/1.0" });
  });
  it.each([
    [{ k: "evil_key", v: "x" }],
    [{ k: "note", v: "x".repeat(81) }],
    [{ k: "note" }],
    [{}],
  ])("rejects %j", async (body) => {
    expect((await handlePush(post("/v1/push-test/report", body), env, makeCtx()))!.status).toBe(400);
    expect(store.map.size).toBe(0);
  });
  it("405 for GET", async () => {
    expect((await handlePush(new Request("https://w.example/v1/push-test/report"), env, makeCtx()))!.status).toBe(405);
  });
});

describe("POST /v1/push-test/send", () => {
  it("encrypts and delivers to the subscription's push service with a VAPID header", async () => {
    const sub = await newSubscription();
    const seen: { url?: string; init?: RequestInit } = {};
    const ctx = makeCtx();
    const res = await handlePush(post("/v1/push-test/send", { subscription: sub, title: "Hi", body: "There", badge: 3 }), env, ctx,
      async (url, init) => { seen.url = url; seen.init = init; return new Response(null, { status: 201 }); });
    expect(res!.status).toBe(202);
    await Promise.all(ctx.jobs);
    expect(seen.url).toBe(sub.endpoint);
    const headers = new Headers(seen.init!.headers);
    expect(headers.get("authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("urgency")).toBe("high");
    expect((seen.init!.body as ArrayBuffer | Uint8Array).byteLength).toBeGreaterThan(100);
    expect(JSON.parse(store.map.get("pt:last_send")!).outcome).toBe("push service answered 201");
  });

  it("holds the push for the requested delay, then sends", async () => {
    vi.useFakeTimers();
    const sub = await newSubscription();
    let calls = 0;
    const ctx = makeCtx();
    const res = await handlePush(post("/v1/push-test/send", { subscription: sub, delay: 10 }), env, ctx, async () => { calls++; return new Response(null, { status: 201 }); });
    expect(await res!.json()).toMatchObject({ sendsInSeconds: 10 });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(ctx.jobs);
    expect(calls).toBe(1);
  });

  it("records a failure instead of throwing when the push service is down", async () => {
    const ctx = makeCtx();
    await handlePush(post("/v1/push-test/send", { subscription: await newSubscription() }), env, ctx, async () => { throw new Error("network down"); });
    await Promise.all(ctx.jobs);
    expect(JSON.parse(store.map.get("pt:last_send")!).outcome).toContain("failed: network down");
  });

  it("refuses to POST to anything that is not a push service (no open relay)", async () => {
    const sub = await newSubscription("https://evil.example/collect");
    let called = false;
    const res = await handlePush(post("/v1/push-test/send", { subscription: sub }), env, makeCtx(), async () => { called = true; return new Response(); });
    expect(res!.status).toBe(400);
    expect(called).toBe(false);
  });

  it.each([
    ["delay too long", { delay: 21 }],
    ["negative delay", { delay: -1 }],
    ["fractional delay", { delay: 1.5 }],
    ["badge too big", { badge: 100 }],
    ["protocol-relative url", { url: "//evil.example" }],
    ["absolute url", { url: "https://evil.example" }],
  ])("rejects %s", async (_n, extra) => {
    const res = await handlePush(post("/v1/push-test/send", { subscription: await newSubscription(), ...extra }), env, makeCtx());
    expect(res!.status).toBe(400);
  });

  it("rejects a missing subscription and oversized bodies", async () => {
    expect((await handlePush(post("/v1/push-test/send", {}), env, makeCtx()))!.status).toBe(400);
    expect((await handlePush(post("/v1/push-test/send", { pad: "x".repeat(5000) }), env, makeCtx()))!.status).toBe(400);
  });

  it("503 without a VAPID key", async () => {
    const res = await handlePush(post("/v1/push-test/send", { subscription: await newSubscription() }), { USED: env.USED }, makeCtx());
    expect(res!.status).toBe(503);
  });

  it("429 when called again within 3 seconds", async () => {
    const ctx = makeCtx();
    const ok = async () => new Response(null, { status: 201 });
    const a = await handlePush(post("/v1/push-test/send", { subscription: await newSubscription() }), env, ctx, ok, 1_000_000);
    const b = await handlePush(post("/v1/push-test/send", { subscription: await newSubscription() }), env, ctx, ok, 1_001_000);
    const c = await handlePush(post("/v1/push-test/send", { subscription: await newSubscription() }), env, ctx, ok, 1_004_000);
    expect([a!.status, b!.status, c!.status]).toEqual([202, 429, 202]);
  });
});
