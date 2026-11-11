// Hash a dashboard passphrase in the format the Worker's src/dashboard/auth.ts expects:
//   pbkdf2$<iterations>$<salt, base64url>$<hash, base64url>
// Cloudflare Workers cap PBKDF2 at 100,000 iterations, so that is what is used. A test checks that the Worker accepts this output.
const ITERATIONS = 100_000;

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

export async function storedPassphrase(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  const hash = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256));
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}
