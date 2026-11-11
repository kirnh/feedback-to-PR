import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sign, verify, type ApprovalPayload } from "../src/token";

const KEY = "test-signing-key-0123456789";
const NOW = 1_800_000_000;
const payload = (over: Partial<ApprovalPayload> = {}): ApprovalPayload => ({
  r: "kirnh/MediSync", i: 1, a: "approve", e: NOW + 600, n: "abcdef0123456789", ...over,
});

describe("token sign/verify", () => {
  it("accepts a freshly signed token and returns its payload", async () => {
    const res = await verify(await sign(payload(), KEY), KEY, NOW);
    expect(res).toEqual({ ok: true, payload: payload() });
  });

  it("rejects a token signed with a different key", async () => {
    const res = await verify(await sign(payload(), "other-key"), KEY, NOW);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload (issue number changed)", async () => {
    const t = await sign(payload({ i: 1 }), KEY);
    const forged = await sign(payload({ i: 2 }), "attacker-key");
    const mixed = `${forged.split(".")[0]}.${t.split(".")[1]}`;
    expect((await verify(mixed, KEY, NOW)).ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const res = await verify(await sign(payload({ e: NOW - 1 }), KEY), KEY, NOW);
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token exactly at its expiry second", async () => {
    expect((await verify(await sign(payload({ e: NOW }), KEY), KEY, NOW)).ok).toBe(true);
  });

  it.each(["", "abc", "a.b.c", ".", "a.", ".b", "!!!.???"])("rejects malformed token %j", async (t) => {
    const res = await verify(t, KEY, NOW);
    expect(res.ok).toBe(false);
  });

  it("rejects a correctly signed payload with an invalid shape", async () => {
    const bad = await sign({ ...payload(), a: "delete" } as unknown as ApprovalPayload, KEY);
    expect(await verify(bad, KEY, NOW)).toEqual({ ok: false, reason: "malformed" });
    const badRepo = await sign({ ...payload(), r: "../etc/passwd" } as ApprovalPayload, KEY);
    expect(await verify(badRepo, KEY, NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("shell minting script is compatible with the verifier", () => {
  const script = new URL("../../scripts/mint-approval-link.sh", import.meta.url).pathname;
  const haveTools = (() => {
    try { execFileSync("jq", ["--version"]); execFileSync("openssl", ["version"]); return existsSync(script); }
    catch { return false; }
  })();

  it.runIf(haveTools)("a token minted by mint-approval-link.sh verifies", async () => {
    const token = execFileSync("bash", [script, "kirnh/MediSync", "7", "reject", "600"], {
      env: { ...process.env, SIGNING_KEY: KEY }, encoding: "utf8",
    });
    const res = await verify(token, KEY, Math.floor(Date.now() / 1000));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toMatchObject({ r: "kirnh/MediSync", i: 7, a: "reject" });
  });
});
