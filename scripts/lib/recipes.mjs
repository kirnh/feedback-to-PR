// How a key is produced: typed (hidden) and checked before it is stored.
// A recipe returns { value } or { error }. Nothing here prints or stores a key.
import { checkAnthropicKey } from "./check-anthropic.mjs";

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
    const f = ctx.fetch ?? fetch;
    const ask = async (url) => {
      try {
        const res = await f(url, { headers: { authorization: `Bearer ${v}` } });
        const body = await res.json().catch(() => ({}));
        return { status: res.status, active: res.ok && body?.result?.status === "active" };
      } catch { return { status: 0, active: false }; }
    };
    // A personal token (My Profile > API Tokens) and an account token (Manage Account > Account API Tokens) are checked at different addresses.
    const personal = await ask("https://api.cloudflare.com/client/v4/user/tokens/verify");
    if (personal.active) return null;
    const account = ctx.cloudflareAccountId ? await ask(`https://api.cloudflare.com/client/v4/accounts/${ctx.cloudflareAccountId}/tokens/verify`) : { status: 0, active: false };
    if (account.active) return null;
    if (personal.status === 0 && account.status === 0) return "Could not reach Cloudflare to check the token.";
    // Say what looks wrong without revealing the value.
    const shape = /^[0-9a-f]{37}$/.test(v) ? "That looks like the Global API Key, which is not an API token. Create a token from the 'Edit Cloudflare Workers' template instead."
      : v.length !== 40 ? `What was entered is ${v.length} characters; a Cloudflare API token is exactly 40. Copy it again with the Copy button, in one go.`
      : /[^A-Za-z0-9_-]/.test(v) ? "The value has characters a token never contains, so the paste was probably altered. Copy it again with the Copy button."
      : "It has the right shape, so Cloudflare itself is refusing it. Check the token is Active and was made from the 'Edit Cloudflare Workers' template for the right account.";
    return `Cloudflare rejected the token (${personal.status}${account.status ? `/${account.status}` : ""}). ${shape}`;
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
export async function runRecipe(recipe, { ask, ctx = {} }) {
  if (recipe.kind !== "prompt") return { error: `Unknown recipe '${recipe.kind}'.` };
  const v = (await ask("Paste the value (nothing is shown): ")).trim();
  if (!v) return { error: "Nothing was entered." };
  const problem = await VALIDATORS[recipe.validate ?? "min-length"]?.(v, ctx);
  return problem ? { error: `${problem}\nNothing was saved.` } : { value: v };
}
