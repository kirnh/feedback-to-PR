import { describe, expect, it } from "vitest";
import {
  checkPassphrase, COOKIE_NAME, hasValidSession, loginAllowed, makeSession, recordLoginFailure, setCookie, storedPassphrase,
} from "../src/dashboard/auth";

const KEY = "signing-key-for-tests-0123456789";
const NOW = 1_800_000_000;
const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) }; };

describe("passphrase storage and check", () => {
  it("stores a salted hash, never the passphrase", async () => {
    const stored = await storedPassphrase("correct horse battery");
    expect(stored).toMatch(/^pbkdf2\$100000\$[\w-]+\$[\w-]+$/);
    expect(stored).not.toContain("correct");
  });
  it("two stores of the same passphrase differ (random salt)", async () => {
    expect(await storedPassphrase("same")).not.toBe(await storedPassphrase("same"));
  });
  it("accepts the right passphrase, rejects wrong ones", async () => {
    const stored = await storedPassphrase("correct horse battery");
    expect(await checkPassphrase("correct horse battery", stored)).toBe(true);
    expect(await checkPassphrase("correct horse batter", stored)).toBe(false);
    expect(await checkPassphrase("", stored)).toBe(false);
  });
  it.each([undefined, "", "plain-text-secret", "pbkdf2$0$a$b", "pbkdf2$999999$a$b", "pbkdf2$100000$!!$??", "other$100000$a$b"])(
    "rejects when the stored value is %j", async (stored) => expect(await checkPassphrase("anything", stored as never)).toBe(false));
  it.each([undefined, null, 42, "x".repeat(201)])("rejects non-string or oversized input %j", async (p) => {
    expect(await checkPassphrase(p, await storedPassphrase("x"))).toBe(false);
  });
});

describe("session cookie", () => {
  const cookie = (v: string) => `${COOKIE_NAME}=${v}`;
  it("a fresh session is valid", async () => expect(await hasValidSession(cookie(await makeSession(KEY, NOW)), KEY, NOW + 10)).toBe(true));
  it("is found among other cookies", async () => {
    expect(await hasValidSession(`a=1; ${cookie(await makeSession(KEY, NOW))}; b=2`, KEY, NOW)).toBe(true);
  });
  it("expires after 30 days", async () => {
    const s = await makeSession(KEY, NOW);
    expect(await hasValidSession(cookie(s), KEY, NOW + 30 * 86_400 - 1)).toBe(true);
    expect(await hasValidSession(cookie(s), KEY, NOW + 30 * 86_400 + 1)).toBe(false);
  });
  it("rejects another key, a tampered payload, missing and malformed cookies", async () => {
    const s = await makeSession(KEY, NOW);
    expect(await hasValidSession(cookie(s), "other-key", NOW)).toBe(false);
    const [p, sig] = s.split(".");
    const forged = btoa(JSON.stringify({ exp: NOW + 99_999_999 })).replace(/=+$/, "");
    expect(await hasValidSession(cookie(`${forged}.${sig}`), KEY, NOW)).toBe(false);
    expect(await hasValidSession(cookie(`${p}.`), KEY, NOW)).toBe(false);
    expect(await hasValidSession(null, KEY, NOW)).toBe(false);
    expect(await hasValidSession("nothing=here", KEY, NOW)).toBe(false);
    expect(await hasValidSession(cookie("garbage"), KEY, NOW)).toBe(false);
  });
  it("a session cookie is not usable as an approval token and vice versa (separate signing domain)", async () => {
    const { sign } = await import("../src/token");
    const approval = await sign({ r: "a/b", i: 1, a: "approve", e: NOW + 60, n: "nonce-12345678" }, KEY);
    expect(await hasValidSession(cookie(approval), KEY, NOW)).toBe(false);
  });
  it("the cookie is HttpOnly, Secure and SameSite=Strict; logout clears it", () => {
    expect(setCookie("v")).toMatch(/HttpOnly/); expect(setCookie("v")).toMatch(/Secure/); expect(setCookie("v")).toMatch(/SameSite=Strict/);
    expect(setCookie("", 0)).toContain("Max-Age=0");
  });
});

describe("login rate limit", () => {
  it("allows 4 failures, blocks after the 5th, and resets after the window", async () => {
    const store = kv();
    for (let i = 0; i < 4; i++) { expect(await loginAllowed(store, "1.2.3.4", NOW * 1000)).toBe(true); await recordLoginFailure(store, "1.2.3.4", NOW * 1000); }
    expect(await loginAllowed(store, "1.2.3.4", NOW * 1000)).toBe(true);
    await recordLoginFailure(store, "1.2.3.4", NOW * 1000);
    expect(await loginAllowed(store, "1.2.3.4", NOW * 1000)).toBe(false);
    expect(await loginAllowed(store, "1.2.3.4", NOW * 1000 + 601_000)).toBe(true);
  });
  it("counts each client separately", async () => {
    const store = kv();
    for (let i = 0; i < 5; i++) await recordLoginFailure(store, "attacker", NOW * 1000);
    expect(await loginAllowed(store, "attacker", NOW * 1000)).toBe(false);
    expect(await loginAllowed(store, "owner", NOW * 1000)).toBe(true);
  });
});
