// Beta codes: how an app's owner lets a specific tester send feedback. Signed, bound to one project, expiring,
// revocable. The tester enters it once in the app's feedback section; it is not a login and carries no identity.
import { b64urlDecode, b64urlEncode } from "../token";

export interface BetaPayload {
  /** project id */
  p: string;
  /** tester label chosen by the owner (e.g. "asha"), shown to nobody but the owner */
  t: string;
  /** expiry, unix seconds */
  e: number;
  /** random nonce; also the handle for revocation */
  n: string;
}

export const BETA_PREFIX = "f2pr_b1";
const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  // Separate signing domain from approval links and dashboard sessions, which share the same base key.
  const key = await crypto.subtle.importKey("raw", enc.encode(`${secret}:beta`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function mintBetaCode(payload: BetaPayload, secret: string): Promise<string> {
  const p = b64urlEncode(enc.encode(JSON.stringify(payload)));
  return `${BETA_PREFIX}.${p}.${b64urlEncode(await hmac(secret, p))}`;
}

export type BetaResult =
  | { ok: true; payload: BetaPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function verifyBetaCode(code: string, secret: string, nowSec: number): Promise<BetaResult> {
  const parts = code.split(".");
  if (parts.length !== 3 || parts[0] !== BETA_PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  let sig: Uint8Array;
  try { sig = b64urlDecode(parts[2]); } catch { return { ok: false, reason: "malformed" }; }
  if (!equal(await hmac(secret, parts[1]), sig)) return { ok: false, reason: "bad_signature" };
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))); } catch { return { ok: false, reason: "malformed" }; }
  const o = payload as Record<string, unknown>;
  if (!o || typeof o.p !== "string" || !/^[a-z0-9-]{1,40}$/.test(o.p) || typeof o.t !== "string" || o.t.length > 40 ||
      typeof o.e !== "number" || typeof o.n !== "string" || o.n.length < 8 || o.n.length > 64) return { ok: false, reason: "malformed" };
  if (o.e < nowSec) return { ok: false, reason: "expired" };
  return { ok: true, payload: o as unknown as BetaPayload };
}
