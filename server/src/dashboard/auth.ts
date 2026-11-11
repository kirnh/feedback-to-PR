// Passphrase login and signed session cookie for the dashboard. One owner, no accounts.
import { b64urlDecode, b64urlEncode } from "../token";
import type { Kv } from "./events";

const enc = new TextEncoder();
/** Cloudflare Workers caps PBKDF2 at 100,000 iterations. */
export const PBKDF2_ITERATIONS = 100_000;
export const COOKIE_NAME = "f2pr_session";
export const SESSION_SECONDS = 30 * 86_400;
const MAX_FAILURES = 5;
const WINDOW_SECONDS = 600;

async function pbkdf2(pass: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** What gets stored as the DASHBOARD_PASS secret: a salted hash, never the passphrase. */
export async function storedPassphrase(pass: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pass, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

export async function checkPassphrase(pass: unknown, stored: string | undefined): Promise<boolean> {
  if (typeof pass !== "string" || pass.length === 0 || pass.length > 200 || !stored) return false;
  const [scheme, iter, salt, hash] = stored.split("$");
  const n = Number(iter);
  if (scheme !== "pbkdf2" || !Number.isInteger(n) || n < 1 || n > PBKDF2_ITERATIONS || !salt || !hash) return false;
  try {
    return constantTimeEqual(await pbkdf2(pass, b64urlDecode(salt), n), b64urlDecode(hash));
  } catch {
    return false;
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  // Domain-separated from approval-link signing, which uses the same base key.
  const key = await crypto.subtle.importKey("raw", enc.encode(`${secret}:dashboard-session`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function makeSession(secret: string, nowSec: number): Promise<string> {
  const p = b64urlEncode(enc.encode(JSON.stringify({ exp: nowSec + SESSION_SECONDS })));
  return `${p}.${b64urlEncode(await hmac(secret, p))}`;
}

export async function hasValidSession(cookieHeader: string | null, secret: string, nowSec: number): Promise<boolean> {
  const raw = cookieHeader?.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  if (!raw) return false;
  const [p, sig] = raw.split(".");
  if (!p || !sig) return false;
  try {
    const expected = await hmac(secret, p);
    if (!constantTimeEqual(expected, b64urlDecode(sig))) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as { exp?: number };
    return typeof exp === "number" && exp >= nowSec;
  } catch {
    return false;
  }
}

export const setCookie = (value: string, maxAge = SESSION_SECONDS) =>
  `${COOKIE_NAME}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;


/** At most 5 wrong passphrases per client per 10 minutes. */
export async function loginAllowed(kv: Kv, client: string, nowMs: number): Promise<boolean> {
  const raw = await kv.get(`rl:login:${client}`);
  if (!raw) return true;
  const { n, first } = JSON.parse(raw) as { n: number; first: number };
  return nowMs - first > WINDOW_SECONDS * 1000 || n < MAX_FAILURES;
}

export async function recordLoginFailure(kv: Kv, client: string, nowMs: number): Promise<void> {
  const raw = await kv.get(`rl:login:${client}`);
  const cur = raw ? (JSON.parse(raw) as { n: number; first: number }) : null;
  const fresh = !cur || nowMs - cur.first > WINDOW_SECONDS * 1000;
  await kv.put(`rl:login:${client}`, JSON.stringify({ n: fresh ? 1 : cur!.n + 1, first: fresh ? nowMs : cur!.first }), { expirationTtl: WINDOW_SECONDS });
}
