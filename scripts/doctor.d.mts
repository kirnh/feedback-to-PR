/** Checks for one app repo. Pure given its injected command runners. */
export interface Result { level: "pass" | "warn" | "fail" | "info"; title: string; detail?: string; fix?: string }
export function runDoctor(opts: { repo: string; worker?: string; remote?: boolean }, deps: { sh: (cmd: string, args: string[], opts?: object) => { code: number; stdout: string; stderr: string }; fetchJson: (url: string) => Promise<{ status: number; json: unknown; error?: string }>; readFile: (p: string) => string; fileExists: (p: string) => boolean; harnessDir: string }): Promise<Result[]>;
export function formatReport(results: Result[]): string;
