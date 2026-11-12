import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanTyped } from "../../scripts/lib/ask-hidden.mjs";
import { runRecipe, VALIDATORS } from "../../scripts/lib/recipes.mjs";
import { buildInventory, loadManifest, renderDoc, renderInventory, setSecret, storesFor, type Facts, type Manifest } from "../../scripts/secrets.mjs";
import { planSync, syncSecrets } from "../../scripts/sync-secrets.mjs";

const root = new URL("../../", import.meta.url).pathname;
const manifest = loadManifest(root);
const NOW = Date.parse("2026-11-12T00:00:00Z");

describe("secrets.manifest.json stays honest", () => {
  const ids = manifest.secrets.map((s) => s.id);
  it("has unique names that GitHub accepts (it forbids names starting with GITHUB_)", () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(?!GITHUB_)[A-Z][A-Z0-9_]*$/);
  });
  it("every key says what it is, where it is used and how to get it", () => {
    for (const s of manifest.secrets) {
      expect(s.what.length, s.id).toBeGreaterThan(20);
      expect(s.usedBy.length, s.id).toBeGreaterThan(0);
      expect(s.howToGet.length, s.id).toBeGreaterThan(5);
    }
  });
  it("worker keys name their Cloudflare secret, and every one is really read by the Worker code", () => {
    const code = (function read(dir: string): string { return readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? read(join(dir, e.name)) : e.name.endsWith(".ts") ? readFileSync(join(dir, e.name), "utf8") : "")).join("\n"); })(join(root, "server/src"));
    for (const s of manifest.secrets.filter((x) => x.scope === "worker")) {
      expect(s.workerName, s.id).toBeTruthy();
      expect(code, `${s.id} -> ${s.workerName}`).toContain(s.workerName!);
    }
  });
  it("every key has a way to be set", () => {
    for (const s of manifest.secrets) expect(s.recipe?.kind, s.id).toBe("prompt");
  });
  it("the apps listed are allowed by the Worker", () => {
    const allowed = /ALLOWED_REPOS\s*=\s*"([^"]*)"/.exec(readFileSync(join(root, "server/wrangler.toml"), "utf8"))![1].split(",").map((s) => s.trim());
    for (const app of manifest.apps) expect(allowed).toContain(app);
  });
  it("every secret an app workflow template uses is in the list (the untested aider provider keys are the known exception)", () => {
    const used = new Set<string>();
    for (const f of readdirSync(join(root, "templates"))) for (const m of readFileSync(join(root, "templates", f), "utf8").matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)) used.add(m[1]);
    const known = new Set(ids);
    const aider = new Set(["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]);
    for (const name of used) expect(known.has(name) || aider.has(name), `${name} is used by a template but not in secrets.manifest.json`).toBe(true);
  });
  it("the deploy workflow passes every Worker key by name, and only those", () => {
    const wf = readFileSync(join(root, ".github/workflows/deploy-worker.yml"), "utf8");
    const passed = [...wf.matchAll(/^\s{6}([A-Z][A-Z0-9_]*): \$\{\{ secrets\.([A-Z][A-Z0-9_]*) \}\}/gm)].map((m) => m[2]).filter((n) => n !== "CLOUDFLARE_API_TOKEN").sort();
    expect(passed).toEqual(manifest.secrets.filter((s) => s.scope === "worker").map((s) => s.id).sort());
  });
  it("docs/SECRETS.md is the current output of the manifest", () => {
    expect(readFileSync(join(root, "docs/SECRETS.md"), "utf8")).toBe(renderDoc(manifest));
  });
});

describe("recipes", () => {
  it("an unknown kind of recipe is refused", async () => {
    expect((await runRecipe({ kind: "random-hex" }, { ask: async () => "x" })).error).toContain("Unknown recipe");
  });
  it("a typed key is trimmed, checked, and refused (with 'Nothing was saved') when the check fails", async () => {
    const ok = await runRecipe({ kind: "prompt", validate: "min-length" }, { ask: async () => "  a-long-enough-topic-name  " });
    expect(ok.value).toBe("a-long-enough-topic-name");
    const bad = await runRecipe({ kind: "prompt", validate: "min-length" }, { ask: async () => "short" });
    expect(bad.error).toContain("Nothing was saved");
    expect((await runRecipe({ kind: "prompt" }, { ask: async () => "   " })).error).toBe("Nothing was entered.");
  });
  it("validators give plain reasons", async () => {
    const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await VALIDATORS.anthropic("not-a-key", {})).toContain("sk-ant-");
    expect(await VALIDATORS.anthropic("sk-ant-x", { fetch: respond(401, { error: { message: "invalid x-api-key" } }) })).toContain("HTTP 401");
    expect(await VALIDATORS.anthropic("sk-ant-x", { fetch: respond(200, {}) })).toBeNull();
    expect(await VALIDATORS["anthropic-triage"]("whatever", { triageProvider: "openai-compatible" })).toBeNull(); // other providers cannot be tested here
    const tok = "a".repeat(40);
    expect(await VALIDATORS["cloudflare-token"](tok, { fetch: respond(200, { result: { status: "active" } }) })).toBeNull();
    expect(await VALIDATORS["cloudflare-token"](tok, { fetch: respond(401, {}) })).toContain("rejected");
    expect(await VALIDATORS["github-token"]("t", { apps: ["o/r"], fetch: respond(200, []) })).toBeNull();
    expect(await VALIDATORS["github-token"]("t", { apps: ["o/r"], fetch: respond(404, {}) })).toContain("o/r");
  });
});

describe("Cloudflare token check: both kinds, and a useful reason that never shows the value", () => {
  const secret = "S3cretValueS3cretValueS3cretValue12345678".slice(0, 40);
  const router = (map: Record<string, { status: number; active?: boolean }>) => (async (url: string) => {
    const hit = Object.entries(map).find(([k]) => url.includes(k))?.[1] ?? { status: 401 };
    return new Response(JSON.stringify({ result: { status: hit.active ? "active" : "disabled" } }), { status: hit.status });
  }) as unknown as typeof fetch;
  const ctx = (f: typeof fetch) => ({ fetch: f, cloudflareAccountId: "acct123" });

  it("accepts a personal token", async () => expect(await VALIDATORS["cloudflare-token"](secret, ctx(router({ "/user/tokens/verify": { status: 200, active: true } })))).toBeNull());
  it("accepts an account token (the personal check says 401, the account check says active)", async () =>
    expect(await VALIDATORS["cloudflare-token"](secret, ctx(router({ "/user/tokens/verify": { status: 401 }, "/accounts/acct123/tokens/verify": { status: 200, active: true } })))).toBeNull());
  it("refuses a disabled token even when the call succeeds", async () =>
    expect(await VALIDATORS["cloudflare-token"](secret, ctx(router({ "/user/tokens/verify": { status: 200, active: false } })))).toContain("rejected"));
  it.each([
    ["the Global API Key", "0123456789abcdef0123456789abcdef01234", "Global API Key"],
    ["a truncated paste", "abc", "3 characters"],
    ["a too-long paste", "a".repeat(80), "80 characters"],
    ["a paste with stray characters", "a".repeat(39) + "~", "altered"],
    ["a well-formed but refused token", "a".repeat(40), "Cloudflare itself is refusing"],
  ])("explains %s", async (_n, value, words) => {
    const msg = (await VALIDATORS["cloudflare-token"](value, ctx(router({}))))!;
    expect(msg).toContain(words);
    expect(msg).not.toContain(value.length > 5 ? value : "\u0000");
  });
  it("says so when Cloudflare cannot be reached", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await VALIDATORS["cloudflare-token"](secret, ctx(down))).toContain("Could not reach");
  });
  it("the account id is defined once in the manifest and the deploy workflow agrees", () => {
    expect(readFileSync(join(root, ".github/workflows/deploy-worker.yml"), "utf8")).toContain(`CLOUDFLARE_ACCOUNT_ID: ${(manifest as { cloudflareAccountId?: string }).cloudflareAccountId}`);
  });
});

describe("hidden input: invisible paste markers cannot corrupt a key", () => {
  it("strips bracketed-paste markers and control characters, keeps the key", () => {
    expect(cleanTyped("\u001b[200~abc-DEF_123\u001b[201~")).toBe("abc-DEF_123");
    expect(cleanTyped("ab\u0007c\u001b[Dd")).toBe("abcd");
    expect(cleanTyped("plain")).toBe("plain");
  });
});

describe("sync to Cloudflare never blanks a working key", () => {
  const all = { WORKER_TRIAGE_LLM_KEY: "triage-value", WORKER_GITHUB_TOKEN: "", ANTHROPIC_API_KEY: "app-only-value", CLOUDFLARE_API_TOKEN: "cf-value" };
  it("copies only worker keys that exist and are not empty", () => {
    const p = planSync(manifest, all);
    expect(p.push).toEqual([{ github: "WORKER_TRIAGE_LLM_KEY", worker: "TRIAGE_LLM_KEY" }]);
    expect(p.skip.map((s) => s.worker)).toContain("GITHUB_TOKEN"); // empty in GitHub: left alone in Cloudflare
  });
  it("never copies app keys or the deploy token to the Worker", async () => {
    const pushedNames: string[] = [];
    await syncSecrets({ manifest, allSecrets: all, put: async (n) => { pushedNames.push(n); return true; } });
    expect(pushedNames).toEqual(["TRIAGE_LLM_KEY"]);
  });
  it("reports failures by name and the result never contains a value", async () => {
    const r = await syncSecrets({ manifest, allSecrets: { WORKER_TRIAGE_LLM_KEY: "triage-value", WORKER_GITHUB_TOKEN: "token-value" }, put: async (n) => n !== "GITHUB_TOKEN" });
    expect(r.failed).toEqual(["GITHUB_TOKEN"]);
    expect(r.pushed).toEqual(["TRIAGE_LLM_KEY"]);
    expect(JSON.stringify(r)).not.toMatch(/triage-value|token-value/);
  });
});

describe("list: one place to see everything", () => {
  const name = (...n: string[]) => n.map((x) => ({ name: x, updatedAt: "2026-11-11T00:00:00Z" }));
  const facts = (over: Partial<Facts> = {}): Facts => ({ harness: name("CLOUDFLARE_API_TOKEN", "WORKER_TRIAGE_LLM_KEY"), apps: { "kirnh/MediSync": name("ANTHROPIC_API_KEY") }, worker: ["TRIAGE_LLM_KEY", "GITHUB_TOKEN"], ...over });
  const status = (rows: ReturnType<typeof buildInventory>, id: string) => rows.find((r) => r.id === id)!.status;

  it("tells apart set, waiting for deploy, only-in-Cloudflare and missing", () => {
    const rows = buildInventory(manifest, facts(), NOW);
    expect(status(rows, "CLOUDFLARE_API_TOKEN")).toBe("set");
    expect(status(rows, "WORKER_TRIAGE_LLM_KEY")).toBe("set");
    expect(status(rows, "WORKER_GITHUB_TOKEN")).toBe("legacy"); // in Cloudflare only
    const waiting = buildInventory(manifest, facts({ worker: ["GITHUB_TOKEN"] }), NOW);
    expect(status(waiting, "WORKER_TRIAGE_LLM_KEY")).toBe("waiting");
    expect(status(buildInventory(manifest, facts({ harness: name("CLOUDFLARE_API_TOKEN"), worker: [] }), NOW), "WORKER_TRIAGE_LLM_KEY")).toBe("missing");
  });
  it("an app key missing from one app is reported with the app's name", () => {
    const rows = buildInventory(manifest, facts({ apps: { "kirnh/MediSync": [] } }), NOW);
    const r = rows.find((x) => x.id === "ANTHROPIC_API_KEY")!;
    expect(r.status).toBe("missing");
    expect(r.note).toContain("kirnh/MediSync");
  });
  it("warns before a token that was meant to expire does, and when it likely has", () => {
    const aged = (days: number) => buildInventory(manifest, { ...facts({ worker: ["GITHUB_TOKEN"] }), harness: [{ name: "WORKER_GITHUB_TOKEN", updatedAt: new Date(NOW - days * 86_400_000).toISOString() }] }, NOW);
    expect(status(aged(1), "WORKER_GITHUB_TOKEN")).toBe("set");
    expect(status(aged(29), "WORKER_GITHUB_TOKEN")).toBe("expiring");
    expect(status(aged(31), "WORKER_GITHUB_TOKEN")).toBe("expired?");
  });
  it("works when Cloudflare cannot be read (status unknown, not 'missing')", () => {
    expect(status(buildInventory(manifest, facts({ worker: null }), NOW), "WORKER_TRIAGE_LLM_KEY")).toBe("set");
  });
  it("the printed report explains each key, says what needs doing, and shows no values", () => {
    const text = renderInventory(buildInventory(manifest, facts(), NOW));
    expect(text).toContain("Used by:");
    expect(text).toContain("Run: node scripts/secrets.mjs setup");
    expect(text).toMatch(/legacy\s+WORKER_GITHUB_TOKEN/);
  });
});

describe("set: stores in the right places, prints nothing secret", () => {
  function world(over: { ghFails?: string } = {}) {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const said: string[] = [];
    const sh = (cmd: string, args: string[], opts?: { input?: string }) => {
      calls.push({ cmd, args, input: opts?.input });
      if (over.ghFails && args.join(" ").includes(over.ghFails)) return { code: 1, stdout: "", stderr: "x" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, said, deps: (ask: (q: string) => Promise<string> = async () => { throw new Error("no ask"); }) => ({ sh, ask, say: (m: string) => said.push(m), root }) };
  }

  it("a Worker key goes to the harness repo and triggers a deploy; the value is never printed or returned", async () => {
    const w = world();
    const r = await setSecret(manifest, "WORKER_TRIAGE_LLM_KEY", { ...w.deps(async () => "sk-ant-" + "x".repeat(30)), fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    expect(r.ok).toBe(true);
    expect(r.needsDeploy).toBe(true);
    const sets = w.calls.filter((c) => c.cmd === "gh" && c.args[0] === "secret");
    expect(sets.map((c) => `${c.args[2]} ${c.args[4]}`)).toEqual(["WORKER_TRIAGE_LLM_KEY kirnh/feedback-to-PR"]);
    expect(JSON.stringify([r, w.said])).not.toContain(sets[0].input!);
  });
  it("an app key goes to the app repos only, and does not trigger a Cloudflare deploy", async () => {
    const w = world();
    const r = await setSecret(manifest, "HARNESS_TOKEN", w.deps(async () => "a-long-enough-token-value"));
    expect(w.calls.map((c) => c.args[4])).toEqual(["kirnh/MediSync"]);
    expect(r.needsDeploy).toBe(false);
  });
  it("a refused check stores nothing at all", async () => {
    const w = world();
    const r = await setSecret(manifest, "HARNESS_TOKEN", w.deps(async () => "short"));
    expect(r.ok).toBe(false);
    expect(w.calls).toHaveLength(0);
  });
  it("unknown names are explained and store nothing", async () => {
    const w = world();
    expect((await setSecret(manifest, "NOPE", w.deps())).message).toContain("Unknown key");
    expect(w.calls).toHaveLength(0);
  });
  it("a GitHub failure stops and says nothing was stored", async () => {
    const w = world({ ghFails: "HARNESS_TOKEN" });
    const r = await setSecret(manifest, "HARNESS_TOKEN", w.deps(async () => "a-long-enough-token-value"));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("nothing");
  });
  it("storesFor: worker keys live in the harness repo, app keys in each app", () => {
    const s = (id: string) => storesFor(manifest as Manifest, manifest.secrets.find((x) => x.id === id)!);
    expect(s("CLOUDFLARE_API_TOKEN")).toEqual([{ repo: "kirnh/feedback-to-PR", name: "CLOUDFLARE_API_TOKEN" }]);
    expect(s("ANTHROPIC_API_KEY")).toEqual([{ repo: "kirnh/MediSync", name: "ANTHROPIC_API_KEY" }]);
  });
});
