// One tiny interface for "ask a model, get text back", so the model and the provider are a config choice,
// not a code change. Anthropic and any OpenAI-compatible endpoint (OpenAI, OpenRouter, Gemini, DeepSeek, local) are supported.

export interface Llm {
  complete(system: string, user: string): Promise<string>;
}

export interface LlmEnv {
  TRIAGE_LLM_KEY?: string;
  /** "anthropic" (default) or "openai-compatible" */
  TRIAGE_PROVIDER?: string;
  TRIAGE_MODEL?: string;
  /** Required for openai-compatible, e.g. https://openrouter.ai/api/v1 */
  TRIAGE_BASE_URL?: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export const DEFAULT_TRIAGE_MODEL = "claude-haiku-5-5";

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/** Returns null when triage is not configured. */
export function makeLlm(env: LlmEnv, doFetch: Fetcher = fetch): Llm | null {
  const key = env.TRIAGE_LLM_KEY;
  if (!key) return null;
  const model = env.TRIAGE_MODEL || DEFAULT_TRIAGE_MODEL;
  const provider = env.TRIAGE_PROVIDER || "anthropic";

  if (provider === "anthropic") {
    return {
      async complete(system, user) {
        const res = await doFetch("https://api.anthropic.com/v1/messages", {
          method: "POST", signal: AbortSignal.timeout(25000),
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 700, system, messages: [{ role: "user", content: user }] }),
        });
        if (!res.ok) throw new LlmError(`Anthropic returned ${res.status}`, res.status);
        const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
        return (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      },
    };
  }

  if (provider === "openai-compatible") {
    const base = (env.TRIAGE_BASE_URL ?? "").replace(/\/+$/, "");
    if (!/^https:\/\//.test(base)) return null;
    return {
      async complete(system, user) {
        const res = await doFetch(`${base}/chat/completions`, {
          method: "POST", signal: AbortSignal.timeout(25000),
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        });
        if (!res.ok) throw new LlmError(`Provider returned ${res.status}`, res.status);
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content ?? "";
      },
    };
  }
  return null;
}
