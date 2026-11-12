import { handleFeedback, type FeedbackEnv } from "./feedback/handler";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: FeedbackEnv, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/health") return json(200, { ok: true });
    if (pathname.startsWith("/v1/feedback")) {
      const res = await handleFeedback(request, env, ctx);
      if (res) return res;
    }
    return json(404, { error: { code: "not_found", message: "Not found." } });
  },
};
