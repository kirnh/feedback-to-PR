import { handleApprove, type Env } from "./approve";
import { handleDashboard, type DashEnv } from "./dashboard/handler";
import { handleFeedback, type FeedbackEnv } from "./feedback/handler";
import { handlePush, type PushEnv } from "./push";

type WorkerEnv = Env & PushEnv & DashEnv & FeedbackEnv;

const notFound = () =>
  new Response(JSON.stringify({ error: { code: "not_found", message: "Not found." } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/health") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    if (pathname === "/v1/approve") return handleApprove(request, env);
    if (pathname === "/v1/session" || pathname === "/v1/session/logout" || pathname === "/v1/dashboard" || pathname.startsWith("/v1/beta-codes")) return (await handleDashboard(request, env)) ?? notFound();
    if (pathname.startsWith("/v1/feedback")) return (await handleFeedback(request, env, ctx)) ?? notFound();
    if (pathname.startsWith("/v1/push")) return (await handlePush(request, env, ctx)) ?? notFound();
    return notFound();
  },
};
