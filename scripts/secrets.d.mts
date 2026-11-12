export interface Secret { id: string; label: string; scope: "harness" | "worker" | "app"; required?: boolean; workerName?: string; derivedFrom?: string; alsoSetInApps?: string; what: string; usedBy: string[]; howToGet: string; recipe?: { kind: string; [k: string]: unknown }; expiresInDays?: number }
export interface Manifest { harnessRepo: string; apps: string[]; worker: string; secrets: Secret[] }
export interface Facts { harness: Array<{ name: string; updatedAt?: string }>; apps: Record<string, Array<{ name: string; updatedAt?: string }>>; worker: string[] | null }
export interface Row { id: string; label: string; scope: string; required: boolean; derived: boolean; what: string; usedBy: string[]; status: string; note: string; updated: string | null }
type Sh = (cmd: string, args: string[], opts?: { input?: string; cwd?: string }) => { code: number; stdout: string; stderr: string };
export function loadManifest(root?: string): Manifest;
export function buildInventory(m: Manifest, facts: Facts, nowMs: number): Row[];
export function renderInventory(rows: Row[]): string;
export function renderDoc(m: Manifest): string;
export function storesFor(m: Manifest, entry: Secret): Array<{ repo: string; name: string }>;
export function setSecret(m: Manifest, id: string, deps: { sh: Sh; ask: (q: string) => Promise<string>; hashPassphrase: (p: string) => Promise<string>; say: (m: string) => void; fetch?: typeof fetch; root?: string }): Promise<{ ok: boolean; message: string; stored?: string[]; needsDeploy?: boolean }>;
