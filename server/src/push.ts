// Web Push feasibility test. Temporary: lets an installed home-screen page subscribe to push, ask the
// Worker to send it a test notification, and report what the phone did. Remove after the test.
import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import { b64urlDecode, b64urlEncode } from "./token";

export interface PushEnv {
  /** Private VAPID key as a JWK JSON string (kty, crv, x, y, d). Secret. */
  VAPID_PRIVATE_JWK?: string;
  USED: KVNamespace;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Ctx = { waitUntil(p: Promise<unknown>): void };

/** Contact URL for the VAPID claim (Apple requires a mailto: or https: subject). */
export const VAPID_SUBJECT = "https://feedback-to-pr.feedback-to-pr-server.workers.dev";

/** What the test page may report. Anything else is rejected. */
export const REPORT_KEYS = [
  "installed", "api_support", "permission", "subscribed", "arrived_closed", "arrived_open",
  "sound", "tap_opens", "badge_api", "badge_visible", "lock_screen", "note",
] as const;

const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

/** Only real browser push services, so this endpoint cannot be used to POST to arbitrary URLs. */
export function isPushEndpoint(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

/** Turn the stored private JWK into the key format the sender needs. */
export function vapidFromJwk(raw: string | undefined) {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, string>;
    if (j.kty !== "EC" || j.crv !== "P-256" || !j.d || !j.x || !j.y) return null;
    const pub = new Uint8Array(65);
    pub[0] = 4; // uncompressed point
    pub.set(b64urlDecode(j.x), 1);
    pub.set(b64urlDecode(j.y), 33);
    return { subject: VAPID_SUBJECT, publicKey: b64urlEncode(pub), privateKey: j.d };
  } catch {
    return null;
  }
}

/**
 * Why a stored key is unusable, in words that reveal nothing about the key itself.
 * Used so a misconfigured secret produces a readable error instead of a silent 503.
 */
export function vapidProblem(raw: string | undefined, visibleNames: string[] = []): string | null {
  if (raw === undefined) return `the VAPID_PRIVATE_JWK secret is not visible to the Worker (names it can see: ${visibleNames.join(", ") || "none"})`;
  if (!raw) return "the VAPID_PRIVATE_JWK secret is present but empty";
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw);
  } catch {
    return `the stored value is not valid JSON (length ${raw.length}, first character code ${raw.charCodeAt(0)}, last ${raw.charCodeAt(raw.length - 1)})`;
  }
  if (!j || typeof j !== "object") return "the stored value is not a JSON object";
  if (j.kty !== "EC" || j.crv !== "P-256") return "the stored key is not an EC P-256 key";
  for (const part of ["d", "x", "y"]) if (typeof j[part] !== "string" || !j[part]) return `the stored key is missing its "${part}" part`;
  for (const part of ["d", "x", "y"]) if ((j[part] as string).length !== 43) return `the "${part}" part has the wrong length (${(j[part] as string).length}, expected 43)`;
  return vapidFromJwk(raw) ? null : "the stored key could not be decoded";
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > 4096) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function deliver(env: PushEnv, sub: PushSubscription, data: unknown, doFetch: Fetcher): Promise<void> {
  const vapid = vapidFromJwk(env.VAPID_PRIVATE_JWK);
  if (!vapid) return;
  let outcome: string;
  try {
    const payload = await buildPushPayload({ data: data as never, options: { ttl: 120, urgency: "high" } }, sub, vapid);
    const res = await doFetch(sub.endpoint, payload as RequestInit);
    outcome = `push service answered ${res.status}`;
  } catch (e) {
    outcome = `failed: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`;
  }
  await env.USED.put("pt:last_send", JSON.stringify({ outcome, t: new Date().toISOString() }), { expirationTtl: 86400 });
}

/**
 * Routes: GET /v1/push/key, POST /v1/push-test/send, POST /v1/push-test/report.
 * Returns null when the path is not a push route.
 */
export async function handlePush(
  request: Request,
  env: PushEnv,
  ctx: Ctx,
  doFetch: Fetcher = fetch,
  nowMs: number = Date.now(),
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === "/v1/push/key") {
    if (request.method !== "GET") return err(405, "method_not_allowed", "Use GET.");
    const vapid = vapidFromJwk(env.VAPID_PRIVATE_JWK);
    if (!vapid) return err(503, "not_configured", `Push is not configured: ${vapidProblem(env.VAPID_PRIVATE_JWK, Object.keys(env))}.`);
    return json(200, { publicKey: vapid.publicKey });
  }

  if (pathname === "/v1/push-test/report") {
    if (request.method !== "POST") return err(405, "method_not_allowed", "Use POST.");
    const body = await readJson(request);
    const k = str(body?.k, 40), v = str(body?.v, 80);
    if (!k || !v || !(REPORT_KEYS as readonly string[]).includes(k)) return err(400, "bad_report", "Unknown report.");
    const ua = (request.headers.get("user-agent") ?? "").slice(0, 100);
    await env.USED.put(`pt:r:${k}`, JSON.stringify({ v, t: new Date(nowMs).toISOString(), ua }), { expirationTtl: 86400 });
    return json(200, { ok: true });
  }

  if (pathname === "/v1/push-test/send") {
    if (request.method !== "POST") return err(405, "method_not_allowed", "Use POST.");
    if (!vapidFromJwk(env.VAPID_PRIVATE_JWK)) return err(503, "not_configured", "Push is not configured on this Worker.");
    const body = await readJson(request);
    const s = body?.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    const p256dh = str(s?.keys?.p256dh, 200), auth = str(s?.keys?.auth, 100);
    if (!s || !isPushEndpoint(s.endpoint) || !p256dh || !auth) return err(400, "bad_subscription", "Invalid push subscription.");

    const delay = body?.delay === undefined ? 0 : Number(body.delay);
    if (!Number.isInteger(delay) || delay < 0 || delay > 20) return err(400, "bad_delay", "Delay must be 0 to 20 seconds.");
    const badge = body?.badge === undefined ? undefined : Number(body.badge);
    if (badge !== undefined && (!Number.isInteger(badge) || badge < 0 || badge > 99)) return err(400, "bad_badge", "Badge must be 0 to 99.");
    const url = str(body?.url, 120) ?? "/push-test/?from=push";
    if (!url.startsWith("/") || url.startsWith("//")) return err(400, "bad_url", "URL must be a path on this site.");

    // One send every 3 seconds is plenty for a test and stops accidental loops.
    const last = Number(await env.USED.get("pt:last_ms"));
    if (last && nowMs - last < 3000) return err(429, "slow_down", "Wait a few seconds between tests.");
    await env.USED.put("pt:last_ms", String(nowMs), { expirationTtl: 60 });

    const sub: PushSubscription = { endpoint: s.endpoint, expirationTime: null, keys: { p256dh, auth } };
    const data = {
      title: str(body?.title, 80) ?? "Change inbox",
      body: str(body?.body, 200) ?? "Test notification",
      url, badge, tag: "push-test",
    };
    const job = (async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000));
      await deliver(env, sub, data, doFetch);
    })();
    ctx.waitUntil(job);
    return json(202, { ok: true, sendsInSeconds: delay });
  }

  return null;
}
