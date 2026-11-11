// Acknowledgement notification sent by the Worker. iPhone constraints that shape it:
// plain text only (markdown is not rendered), emoji tags work, click opens the issue.

export interface NtfyEnv {
  /** Topic for low-priority progress messages. If unset, acknowledgements are skipped. */
  NTFY_PROGRESS_TOPIC?: string;
  /** Defaults to https://ntfy.sh */
  NTFY_SERVER?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type AckAction = "approve" | "reject";

/** Build the acknowledgement message. Pure, so it is easy to test. */
export function ackMessage(repo: string, issue: number, action: AckAction, topic: string) {
  const project = repo.split("/")[1] ?? repo;
  return action === "approve"
    ? {
        topic,
        title: `[${project}] #${issue} · Approved, starting`,
        message: "The fix run is starting. It usually takes about 15 minutes. You will get a message when it finishes.",
        tags: ["white_check_mark"],
        priority: 2,
        click: `https://github.com/${repo}/issues/${issue}`,
      }
    : {
        topic,
        title: `[${project}] #${issue} · Rejected`,
        message: "The issue was closed as not planned. No run was started.",
        tags: ["no_entry_sign"],
        priority: 2,
        click: `https://github.com/${repo}/issues/${issue}`,
      };
}

/**
 * Tell the owner their tap was received. Best effort: never throws and never delays the
 * response by more than a couple of seconds, because the approval itself already succeeded.
 */
export async function sendAck(
  env: NtfyEnv,
  repo: string,
  issue: number,
  action: AckAction,
  doFetch: Fetch = fetch,
): Promise<boolean> {
  const topic = env.NTFY_PROGRESS_TOPIC;
  if (!topic) return false;
  try {
    const res = await doFetch(env.NTFY_SERVER ?? "https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ackMessage(repo, issue, action, topic)),
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
