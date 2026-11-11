// Test an Anthropic API key with one 1-token request. The wording of the reasons is kept identical to
// scripts/preflight-anthropic.sh (a test compares them), so a user sees the same explanation everywhere.
const HINTS = {
  401: "The API key was rejected. Create a new key in the Anthropic console and update the ANTHROPIC_API_KEY secret.",
  403: "The key is not allowed to use this model or API.",
  404: "The model was not found. Check agent.model in harness.config.yml.",
  429: "Rate limited or out of quota. Check limits and usage in the Anthropic console.",
  400: "The request was rejected; this is often a billing problem such as a credit balance that is too low.",
};

/** Returns { ok: true } or { ok: false, reason }. Never includes the key. */
export async function checkAnthropicKey({ key, model, url = "https://api.anthropic.com/v1/messages", doFetch = fetch }) {
  let res;
  try {
    res = await doFetch(url, {
      method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
  } catch {
    return { ok: false, reason: "Could not reach the Anthropic API (network error or timeout)." };
  }
  if (res.status === 200) return { ok: true };
  let msg = "";
  try { msg = String((await res.json())?.error?.message ?? "").replace(/[\r\n]/g, "").slice(0, 200); } catch { /* not JSON */ }
  const hint = HINTS[res.status] ?? (res.status >= 500 ? "The Anthropic API had a server error. Try again in a few minutes." : "Unexpected response.");
  return { ok: false, reason: `Anthropic API check failed (HTTP ${res.status}): ${msg || "no message"}. ${hint}` };
}
