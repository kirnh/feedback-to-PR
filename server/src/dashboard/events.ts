// A short log of approval attempts, so failures (expired token, wrong repo, GitHub refusing) are
// visible on the dashboard instead of only in Cloudflare's logs.
export interface ApprovalEvent {
  /** ISO time */
  t: string;
  /** HTTP status the Worker answered with */
  status: number;
  /** "ok" or the error code */
  code: string;
  action?: "approve" | "reject";
  repo?: string;
  issue?: number;
  /** Short human-readable message (never contains a token or link) */
  message?: string;
}

/** The two key-value operations used here. Cloudflare's KVNamespace satisfies this; so do simple test fakes. */
export interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
const KEY = "evt:log";
const MAX_EVENTS = 60;

export async function recordEvent(kv: Kv, e: ApprovalEvent): Promise<void> {
  try {
    const cur = JSON.parse((await kv.get(KEY)) ?? "[]") as ApprovalEvent[];
    await kv.put(KEY, JSON.stringify([e, ...cur].slice(0, MAX_EVENTS)), { expirationTtl: 30 * 86_400 });
  } catch {
    /* logging must never break an approval */
  }
}

export async function readEvents(kv: Kv): Promise<ApprovalEvent[]> {
  try {
    return JSON.parse((await kv.get(KEY)) ?? "[]") as ApprovalEvent[];
  } catch {
    return [];
  }
}

/** Statuses worth the owner's attention. 405 (scanner), 409 (duplicate tap) and 410 (expired) are routine. */
export const isProblem = (e: ApprovalEvent) => e.status >= 500 || e.status === 401 || e.status === 403;

export interface FeedbackFailure {
  t: string;
  id: string;
  project: string;
  /** Short machine-readable reason, e.g. github_read_403, triage_not_configured */
  failure: string;
}

const FB_KEY = "evt:feedback-failures";

export async function recordFeedbackFailure(kv: Kv, f: FeedbackFailure): Promise<void> {
  try {
    const cur = JSON.parse((await kv.get(FB_KEY)) ?? "[]") as FeedbackFailure[];
    await kv.put(FB_KEY, JSON.stringify([f, ...cur].slice(0, 30)), { expirationTtl: 30 * 86_400 });
  } catch {
    /* logging must never break intake */
  }
}

export async function readFeedbackFailures(kv: Kv): Promise<FeedbackFailure[]> {
  try {
    return JSON.parse((await kv.get(FB_KEY)) ?? "[]") as FeedbackFailure[];
  } catch {
    return [];
  }
}
