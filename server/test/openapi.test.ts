import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mintBetaCode } from "../src/feedback/beta";
import { handleFeedback, type FeedbackEnv } from "../src/feedback/handler";

// The published contract (spec/openapi.yaml) must describe what the Worker really does.
const spec = parse(readFileSync(new URL("../../spec/openapi.yaml", import.meta.url), "utf8")) as {
  openapi: string;
  paths: Record<string, Record<string, { responses: Record<string, unknown>; security?: unknown[] }>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, { properties?: Record<string, unknown>; required?: string[]; enum?: string[] }> };
};

const NOW = Date.parse("2026-11-11T08:00:00Z");
const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) }; };
let env: FeedbackEnv;
const ctx = { waitUntil() {} };
beforeEach(() => { env = { SIGNING_KEY: "k".repeat(32), GITHUB_TOKEN: "t", ALLOWED_REPOS: "o/r", PROJECTS: '{"app":{"repo":"o/r","name":"App"}}', USED: kv() }; });
const code = () => mintBetaCode({ p: "app", t: "a", e: Math.floor(NOW / 1000) + 3600, n: "nonce-0123456" }, env.SIGNING_KEY);

describe("spec/openapi.yaml", () => {
  it("is a valid OpenAPI 3.1 document with the intake paths and a bearer scheme", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/health", "/v1/feedback", "/v1/feedback/{id}"]));
    expect(spec.components.securitySchemes).toHaveProperty("betaCode");
    expect(spec.paths["/v1/feedback"].post.security).toBeTruthy();
  });

  it("documents exactly the statuses POST /v1/feedback can return", () => {
    expect(Object.keys(spec.paths["/v1/feedback"].post.responses).sort()).toEqual(["202", "400", "401", "429"]);
  });

  it("lists every status the service can report", () => {
    expect(spec.components.schemas.FeedbackStatus.properties!.status).toMatchObject({ enum: ["received", "triaged", "duplicate", "rejected", "failed"] });
  });

  it("every status the Worker returns for the documented requests is in the spec", async () => {
    const docs = spec.paths["/v1/feedback"].post.responses;
    const req = (headers: Record<string, string>, body: string) => new Request("https://w.example/v1/feedback", { method: "POST", headers, body });
    const results = [
      (await handleFeedback(req({ authorization: `Bearer ${await code()}` }, JSON.stringify({ message: "hello there" })), env, ctx, undefined, NOW))!.status,
      (await handleFeedback(req({ authorization: `Bearer ${await code()}` }, "{bad"), env, ctx, undefined, NOW))!.status,
      (await handleFeedback(req({}, "{}"), env, ctx, undefined, NOW))!.status,
    ];
    for (const status of results) expect(Object.keys(docs)).toContain(String(status));
  });

  it("the request schema matches what the Worker accepts: message plus the six context fields, nothing else required", () => {
    const req = spec.components.schemas.FeedbackRequest;
    expect(req.required).toEqual(["message"]);
    expect(Object.keys((req.properties!.context as { properties: object }).properties).sort()).toEqual(["app_version", "device", "locale", "os", "platform", "screen"]);
  });
});
