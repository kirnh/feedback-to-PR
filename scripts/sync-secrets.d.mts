import type { Manifest } from "./secrets.mjs";
export function planSync(m: Manifest, all: Record<string, string>): { push: Array<{ github: string; worker: string }>; skip: Array<{ github: string; worker: string }> };
export function syncSecrets(a: { manifest: Manifest; allSecrets: Record<string, string>; put: (name: string, value: string) => boolean | Promise<boolean> }): Promise<{ pushed: string[]; skipped: string[]; failed: string[] }>;
