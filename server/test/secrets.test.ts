import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storedPassphrase } from "../scripts/lib/passphrase-hash.mjs";
import { generateVapid, runRecipe, VALIDATORS } from "../../scripts/lib/recipes.mjs";
import { buildInventory, loadManifest, renderDoc, renderInventory, setSecret, storesFor, type Facts, type Manifest } from "../../scripts/secrets.mjs";
import { planSync, syncSecrets } from "../../scripts/sync-secrets.mjs";
import { checkPassphrase } from "../src/dashboard/auth";
import { vapidFromJwk } from "../src/push";

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
  it("copies are tied to a source that sets them, and everything else has a way to be set", () => {
    for (const s of manifest.secrets.filter((x) => x.derivedFrom)) {
      const src = manifest.secrets.find((x) => x.id === s.derivedFrom)!;
      expect(src, s.id).toBeTruthy();
      expect(src.alsoSetInApps, s.id).toBe(s.id);
    }
    for (const s of manifest.secrets.filter((x) => !x.derivedFrom)) expect(s.recipe, s.id).toBeTruthy();
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
  const hash = storedPassphrase;
  const noAsk = async () => { throw new Error("should not ask"); };
  it("generated keys are random, the right shape, and never ask you anything", async () => {
    const a = await runRecipe({ kind: "random-hex", bytes: 32 }, { ask: noAsk, hashPassphrase: hash });
    const b = await runRecipe({ kind: "random-hex", bytes: 32 }, { ask: noAsk, hashPassphrase: hash });
    expect(a.value).toMatch(/^[0-9a-f]{64}$/);
    expect(a.value).not.toBe(b.value);
    expect((await runRecipe({ kind: "topic", prefix: "medisync-progress" }, { ask: noAsk, hashPassphrase: hash })).value).toMatch(/^medisync-progress-[0-9a-f]{24}$/);
  });
  it("the generated web-push key is accepted by the Worker", async () => {
    expect(vapidFromJwk(await generateVapid())).not.toBeNull();
  });
  it("a passphrase is asked for twice, must match, and is stored as a hash the Worker accepts", async () => {
    const answers = ["four random words", "four random words"];
    const r = await runRecipe({ kind: "passphrase" }, { ask: async () => answers.shift()!, hashPassphrase: hash });
    expect(r.value).not.toContain("random");
    expect(await checkPassphrase("four random words", r.value)).toBe(true);
    const mismatch = ["four random words", "different words here"];
    expect((await runRecipe({ kind: "passphrase" }, { ask: async () => mismatch.shift()!, hashPassphrase: hash })).error).toContain("did not match");
    expect((await runRecipe({ kind: "passphrase" }, { ask: async () => "short", hashPassphrase: hash })).error).toContain("Too short");
  });
  it("a typed key is trimmed, checked, and refused (with 'Nothing was saved') when the check fails", async () => {
    const ok = await runRecipe({ kind: "prompt", validate: "min-length" }, { ask: async () => "  a-long-enough-topic-name  ", hashPassphrase: hash });
    expect(ok.value).toBe("a-long-enough-topic-name");
    const bad = await runRecipe({ kind: "prompt", validate: "min-length" }, { ask: async () => "short", hashPassphrase: hash });
    expect(bad.error).toContain("Nothing was saved");
    expect((await runRecipe({ kind: "prompt" }, { ask: async () => "   ", hashPassphrase: hash })).error).toBe("Nothing was entered.");
  });
  it("validators give plain reasons", async () => {
    const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await VALIDATORS.anthropic("not-a-key", {})).toContain("sk-ant-");
    expect(await VALIDATORS.anthropic("sk-ant-x", { fetch: respond(401, { error: { message: "invalid x-api-key" } }) })).toContain("HTTP 401");
    expect(await VALIDATORS.anthropic("sk-ant-x", { fetch: respond(200, {}) })).toBeNull();
    expect(await VALIDATORS["anthropic-triage"]("whatever", { triageProvider: "openai-compatible" })).toBeNull(); // other providers cannot be tested here
    expect(await VALIDATORS["cloudflare-token"]("t", { fetch: respond(200, { result: { status: "active" } }) })).toBeNull();
    expect(await VALIDATORS["cloudflare-token"]("t", { fetch: respond(401, {}) })).toContain("rejected");
    expect(await VALIDATORS["github-token"]("t", { apps: ["o/r"], fetch: respond(200, []) })).toBeNull();
    expect(await VALIDATORS["github-token"]("t", { apps: ["o/r"], fetch: respond(404, {}) })).toContain("o/r");
  });
});

describe("sync to Cloudflare never blanks a working key", () => {
  const all = { WORKER_SIGNING_KEY: "sig-value", WORKER_GITHUB_TOKEN: "", ANTHROPIC_API_KEY: "app-only-value", CLOUDFLARE_API_TOKEN: "cf-value" };
  it("copies only worker keys that exist and are not empty", () => {
    const p = planSync(manifest, all);
    expect(p.push).toEqual([{ github: "WORKER_SIGNING_KEY", worker: "SIGNING_KEY" }]);
    expect(p.skip.map((s) => s.worker)).toContain("GITHUB_TOKEN"); // empty in GitHub: left alone in Cloudflare
    expect(p.skip.map((s) => s.worker)).toContain("DASHBOARD_PASS"); // absent in GitHub: left alone
  });
  it("never copies app keys or the deploy token to the Worker", async () => {
    const pushedNames: string[] = [];
    await syncSecrets({ manifest, allSecrets: all, put: async (n) => { pushedNames.push(n); return true; } });
    expect(pushedNames).toEqual(["SIGNING_KEY"]);
  });
  it("reports failures by name and the result never contains a value", async () => {
    const r = await syncSecrets({ manifest, allSecrets: { WORKER_SIGNING_KEY: "sig-value", WORKER_DASHBOARD_PASS: "hash-value" }, put: async (n) => n !== "DASHBOARD_PASS" });
    expect(r.failed).toEqual(["DASHBOARD_PASS"]);
    expect(r.pushed).toEqual(["SIGNING_KEY"]);
    expect(JSON.stringify(r)).not.toMatch(/sig-value|hash-value/);
  });
});

describe("list: one place to see everything", () => {
  const name = (...n: string[]) => n.map((x) => ({ name: x, updatedAt: "2026-11-11T00:00:00Z" }));
  const facts = (over: Partial<Facts> = {}): Facts => ({ harness: name("CLOUDFLARE_API_TOKEN", "WORKER_SIGNING_KEY"), apps: { "kirnh/MediSync": name("ANTHROPIC_API_KEY", "NTFY_TOPIC", "APPROVAL_SIGNING_KEY") }, worker: ["SIGNING_KEY", "GITHUB_TOKEN"], ...over });
  const status = (rows: ReturnType<typeof buildInventory>, id: string) => rows.find((r) => r.id === id)!.status;

  it("tells apart set, waiting for deploy, only-in-Cloudflare and missing", () => {
    const rows = buildInventory(manifest, facts({ worker: ["SIGNING_KEY", "GITHUB_TOKEN", "DASHBOARD_PASS"] }), NOW);
    expect(status(rows, "CLOUDFLARE_API_TOKEN")).toBe("set");
    expect(status(rows, "WORKER_SIGNING_KEY")).toBe("set");
    expect(status(rows, "WORKER_GITHUB_TOKEN")).toBe("legacy"); // in Cloudflare only
    expect(status(rows, "WORKER_DASHBOARD_PASS")).toBe("legacy");
    expect(status(rows, "WORKER_TRIAGE_LLM_KEY")).toBe("missing");
    const waiting = buildInventory(manifest, facts({ worker: ["GITHUB_TOKEN"] }), NOW);
    expect(status(waiting, "WORKER_SIGNING_KEY")).toBe("waiting");
  });
  it("an app key missing from one app is reported with the app's name", () => {
    const rows = buildInventory(manifest, facts({ apps: { "kirnh/MediSync": name("NTFY_TOPIC") } }), NOW);
    const r = rows.find((x) => x.id === "ANTHROPIC_API_KEY")!;
    expect(r.status).toBe("missing");
    expect(r.note).toContain("kirnh/MediSync");
  });
  it("warns before a token that was meant to expire does, and when it likely has", () => {
    const aged = (days: number) => buildInventory(manifest, { ...facts({ worker: ["GITHUB_TOKEN"] }), harness: [{ name: "WORKER_GITHUB_TOKEN", updatedAt: new Date(NOW - days * 86_400_000).toISOString() }] }, NOW);
    expect(status(aged(1), "WORKER_GITHUB_TOKEN")).toBe("set");
    expect(status(aged(5), "WORKER_GITHUB_TOKEN")).toBe("expiring");
    expect(status(aged(8), "WORKER_GITHUB_TOKEN")).toBe("expired?");
  });
  it("works when Cloudflare cannot be read (status unknown, not 'missing')", () => {
    expect(status(buildInventory(manifest, facts({ worker: null }), NOW), "WORKER_SIGNING_KEY")).toBe("set");
  });
  it("the printed report explains each key, says what needs doing, and shows no values", () => {
    const text = renderInventory(buildInventory(manifest, facts(), NOW));
    expect(text).toContain("Used by:");
    expect(text).toContain("Run: node scripts/secrets.mjs setup");
    expect(text).toMatch(/MISSING\s+WORKER_DASHBOARD_PASS|legacy\s+WORKER_DASHBOARD_PASS|MISSING\s+WORKER_GITHUB_TOKEN|legacy\s+WORKER_GITHUB_TOKEN/);
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
    return { calls, said, deps: (ask: (q: string) => Promise<string> = async () => { throw new Error("no ask"); }) => ({ sh, ask, hashPassphrase: storedPassphrase, say: (m: string) => said.push(m), root }) };
  }

  it("the signing key is generated once and written to the harness repo AND to every app, as the same value", async () => {
    const w = world();
    const r = await setSecret(manifest, "WORKER_SIGNING_KEY", w.deps());
    expect(r.ok).toBe(true);
    expect(r.needsDeploy).toBe(true);
    const sets = w.calls.filter((c) => c.cmd === "gh" && c.args[0] === "secret");
    expect(sets.map((c) => `${c.args[2]} ${c.args[4]}`)).toEqual(["WORKER_SIGNING_KEY kirnh/feedback-to-PR", "APPROVAL_SIGNING_KEY kirnh/MediSync"]);
    expect(new Set(sets.map((c) => c.input)).size).toBe(1);
    expect(sets[0].input).toMatch(/^[0-9a-f]{64}$/);
  });
  it("the value is never printed or returned", async () => {
    const w = world();
    const r = await setSecret(manifest, "WORKER_SIGNING_KEY", w.deps());
    const value = w.calls.find((c) => c.args[0] === "secret")!.input!;
    expect(JSON.stringify([r, w.said])).not.toContain(value);
  });
  it("an app key goes to the app repos only, and does not trigger a Cloudflare deploy", async () => {
    const w = world();
    const r = await setSecret(manifest, "NTFY_TOPIC", w.deps(async () => "a-long-private-topic-name"));
    expect(w.calls.map((c) => c.args[4])).toEqual(["kirnh/MediSync"]);
    expect(r.needsDeploy).toBe(false);
  });
  it("a refused check stores nothing at all", async () => {
    const w = world();
    const r = await setSecret(manifest, "NTFY_TOPIC", w.deps(async () => "short"));
    expect(r.ok).toBe(false);
    expect(w.calls).toHaveLength(0);
  });
  it("copies cannot be set directly; unknown names are explained", async () => {
    const w = world();
    expect((await setSecret(manifest, "APPROVAL_SIGNING_KEY", w.deps())).message).toContain("Set WORKER_SIGNING_KEY instead");
    expect((await setSecret(manifest, "NOPE", w.deps())).message).toContain("Unknown key");
    expect(w.calls).toHaveLength(0);
  });
  it("a GitHub failure stops and says what was already stored", async () => {
    const w = world({ ghFails: "APPROVAL_SIGNING_KEY" });
    const r = await setSecret(manifest, "WORKER_SIGNING_KEY", w.deps());
    expect(r.ok).toBe(false);
    expect(r.message).toContain("WORKER_SIGNING_KEY in kirnh/feedback-to-PR");
  });
  it("a generated phone topic goes to the clipboard, not to the screen", async () => {
    const w = world();
    await setSecret(manifest, "WORKER_NTFY_PROGRESS_TOPIC", w.deps());
    const topic = w.calls.find((c) => c.args[0] === "secret")!.input!;
    expect(w.calls.some((c) => c.cmd === "pbcopy" && c.input === topic)).toBe(true);
    expect(w.said.join("\n")).toContain("clipboard");
    expect(w.said.join("\n")).not.toContain(topic);
  });
  it("storesFor: worker keys live in the harness repo, app keys in each app", () => {
    const s = (id: string) => storesFor(manifest as Manifest, manifest.secrets.find((x) => x.id === id)!);
    expect(s("CLOUDFLARE_API_TOKEN")).toEqual([{ repo: "kirnh/feedback-to-PR", name: "CLOUDFLARE_API_TOKEN" }]);
    expect(s("ANTHROPIC_API_KEY")).toEqual([{ repo: "kirnh/MediSync", name: "ANTHROPIC_API_KEY" }]);
  });
});
