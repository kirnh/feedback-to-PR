import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAnthropicKey } from "../../scripts/lib/check-anthropic.mjs";

const run = promisify(execFile);
const preflight = new URL("../../scripts/preflight-anthropic.sh", import.meta.url).pathname;
const haveJq = (() => { try { execFileSync("jq", ["--version"]); return true; } catch { return false; } })();

describe.runIf(haveJq)("the local key check and the CI preflight agree", () => {
  let server: Server;
  let url = "";
  let reply: { status: number; raw: string } = { status: 200, raw: "{}" };
  beforeAll(async () => {
    server = createServer((_req, res) => { res.writeHead(reply.status, { "content-type": "application/json" }); res.end(reply.raw); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
  });
  afterAll(() => server.close());

  async function bothSay(status: number, raw: string) {
    reply = { status, raw };
    const dir = mkdtempSync(join(tmpdir(), "key-"));
    try { await run("bash", [preflight], { env: { ...process.env, TRACE_DIR: dir, ANTHROPIC_API_KEY: "sk-ant-SECRET", MODEL: "m", ANTHROPIC_API_URL: url } }); } catch { /* non-zero exit is expected */ }
    const shell = existsSync(join(dir, "failure_reason.txt")) ? readFileSync(join(dir, "failure_reason.txt"), "utf8") : null;
    const js = await checkAnthropicKey({ key: "sk-ant-SECRET", model: "m", url });
    return { shell, js };
  }

  it.each([
    [401, '{"error":{"message":"invalid x-api-key"}}'],
    [400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'],
    [403, '{"error":{"message":"forbidden"}}'],
    [404, '{"error":{"message":"model: nope"}}'],
    [429, '{"error":{"message":"rate limit exceeded"}}'],
    [529, '{"error":{"message":"overloaded"}}'],
    [418, '{"error":{"message":"teapot"}}'],
    [401, "not json at all"],
  ])("HTTP %i gives the same words in both", async (status, raw) => {
    const { shell, js } = await bothSay(status, raw);
    expect(js.ok).toBe(false);
    expect(js.ok ? "" : js.reason).toBe(shell);
  });

  it("both accept a working key", async () => {
    const { shell, js } = await bothSay(200, "{}");
    expect(shell).toBeNull();
    expect(js).toEqual({ ok: true });
  });

  it("neither puts the key in its message", async () => {
    const { shell, js } = await bothSay(401, '{"error":{"message":"invalid x-api-key"}}');
    expect(shell).not.toContain("SECRET");
    expect(JSON.stringify(js)).not.toContain("SECRET");
  });

  it("the local check reports an unreachable API without throwing", async () => {
    const r = await checkAnthropicKey({ key: "sk-ant-x", model: "m", url: "http://127.0.0.1:1/v1/messages" });
    expect(r).toEqual({ ok: false, reason: "Could not reach the Anthropic API (network error or timeout)." });
  });
});
