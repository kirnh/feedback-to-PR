export function checkAnthropicKey(opts: { key: string; model: string; url?: string; doFetch?: typeof fetch }): Promise<{ ok: true } | { ok: false; reason: string }>;
