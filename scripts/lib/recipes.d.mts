export function generateVapid(): Promise<string>;
export const VALIDATORS: Record<string, (v: string, ctx: { apps?: string[]; cloudflareAccountId?: string; fetch?: typeof fetch; triageProvider?: string; triageModel?: string; agentModel?: string }) => Promise<string | null>>;
export function runRecipe(recipe: { kind: string; [k: string]: unknown }, a: { ask: (q: string) => Promise<string>; ctx?: object; hashPassphrase: (p: string) => Promise<string> }): Promise<{ value?: string; generated?: boolean; error?: string }>;
