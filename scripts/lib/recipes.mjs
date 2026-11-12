// How each kind of key is produced: generated, or typed (hidden) and checked before it is stored.
// A recipe returns { value } or { error }. Nothing here prints or stores a key.
import { checkAnthropicKey } from "./check-anthropic.mjs";

const hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function generateVapid() {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return JSON.stringify(await crypto.subtle.exportKey("jwk", privateKey));
}

/** Each validator gets the typed value and returns null when fine, or a plain-words reason. */
export const VALIDATORS = {
  "min-length": async (v) => (v.length >= 16 ? null : "That is too short. Use at least 16 characters."),

  anthropic: async (v, ctx) => {
    if (!v.startsWith("sk-ant-")) return "That does not look like an Anthropic key (it should start with sk-ant-).";
    const r = await checkAnthropicKey({ key: v, model: ctx.agentModel ?? "claude-sonnet-5-5", doFetch: ctx.fetch });
    return r.ok ? null : r.reason;
  },

  "anthropic-triage": async (v, ctx) => {
    if (ctx.triageProvider && ctx.triageProvider !== "anthropic") return null; // another provider: cannot be tested here
    if (!v.startsWith("sk-ant-")) return "That does not look like an Anthropic key (it should start with sk-ant-).";
    const r = await checkAnthropicKey({ key: v, model: ctx.triageModel ?? "claude-haiku-5-5", doFetch: ctx.fetch });
    return r.ok ? null : r.reason;
  },

  "cloudflare-token": async (v, ctx) => {
    let res;
    try { res = await (ctx.fetch ?? fetch)("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: { authorization: `Bearer ${v}` } }); }
    catch { return "Could not reach Cloudflare to check the token."; }
    const body = await res.json().catch(() => ({}));
    return res.ok && body?.result?.status === "active" ? null : `Cloudflare rejected the token (${res.status}). Create it again from the 'Edit Cloudflare Workers' template.`;
  },

  "github-token": async (v, ctx) => {
    const repo = ctx.apps?.[0];
    if (!repo) return null;
    let res;
    try { res = await (ctx.fetch ?? fetch)(`https://api.github.com/repos/${repo}/issues?per_page=1`, { headers: { authorization: `Bearer ${v}`, accept: "application/vnd.github+json", "user-agent": "feedback-to-pr-secrets" } }); }
    catch { return "Could not reach GitHub to check the token."; }
    return res.ok ? null : `GitHub says ${res.status} when this token reads ${repo}. Check that the token covers that repo and has Issues access.`;
  },
};

/**
 * Produce the value for one secret. `ask` is injected so this stays testable:
 *   ask(question) -> hidden typed text.
 */
export async function runRecipe(recipe, { ask, ctx = {}, hashPassphrase }) {
  switch (recipe.kind) {
    case "random-hex": return { value: hex(recipe.bytes ?? 32), generated: true };
    case "topic": return { value: `${recipe.prefix}-${hex(12)}`, generated: true };
    case "vapid": return { value: await generateVapid(), generated: true };
    case "passphrase": {
      const a = await ask("Choose a passphrase (at least 10 characters, nothing is shown): ");
      if (a.length < 10) return { error: "Too short. Use at least 10 characters, for example four random words." };
      if (a !== (await ask("Type it again: "))) return { error: "They did not match. Nothing was saved." };
      return { value: await hashPassphrase(a) };
    }
    case "prompt": {
      const v = (await ask("Paste the value (nothing is shown): ")).trim();
      if (!v) return { error: "Nothing was entered." };
      const problem = await VALIDATORS[recipe.validate ?? "min-length"]?.(v, ctx);
      return problem ? { error: `${problem}\nNothing was saved.` } : { value: v };
    }
    default: return { error: `Unknown recipe '${recipe.kind}'.` };
  }
}
