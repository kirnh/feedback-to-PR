// Signed, expiring approval tokens: base64url(payload JSON) + "." + base64url(HMAC-SHA256(payload part)).
// The workflow that sends the notification mints these; the Worker verifies them.
// A token authorizes exactly one action on one issue until it expires. It contains no credential.

export type ApprovalPayload = {
  /** owner/repo */
  r: string;
  /** issue number */
  i: number;
  /** action */
  a: "approve" | "reject";
  /** expiry, unix seconds */
  e: number;
  /** random nonce, used to make the token single-use */
  n: string;
};

export type VerifyResult =
  | { ok: true; payload: ApprovalPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function hmacKey(secret: string, usage: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function sign(payload: ApprovalPayload, secret: string): Promise<string> {
  const p = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(p));
  return `${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

function isPayload(x: unknown): x is ApprovalPayload {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.r === "string" && /^[\w.-]+\/[\w.-]+$/.test(o.r) &&
    Number.isInteger(o.i) && (o.i as number) > 0 &&
    (o.a === "approve" || o.a === "reject") &&
    typeof o.e === "number" && Number.isFinite(o.e) &&
    typeof o.n === "string" && o.n.length >= 8 && o.n.length <= 64
  );
}

export async function verify(token: string, secret: string, nowSec: number): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [p, s] = parts;

  let sig: Uint8Array;
  try {
    sig = b64urlDecode(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), sig, enc.encode(p));
  if (!valid) return { ok: false, reason: "bad_signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPayload(payload)) return { ok: false, reason: "malformed" };
  if (payload.e < nowSec) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
