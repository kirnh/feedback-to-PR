// Read-only GitHub access for the dashboard. Each call reports its own failure so one missing
// permission shows up as a clear problem instead of breaking the whole page.

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type GhResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export interface GhReader {
  get<T>(path: string): Promise<GhResult<T>>;
  /** Fine-grained tokens report their expiry in a response header. Null until a call has been made or if absent. */
  tokenExpiry(): string | null;
}

export function makeReader(token: string, doFetch: Fetcher = fetch): GhReader {
  let expiry: string | null = null;
  return {
    tokenExpiry: () => expiry,
    async get<T>(path: string): Promise<GhResult<T>> {
      let res: Response;
      try {
        res = await doFetch(`https://api.github.com${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "feedback-to-pr-dashboard",
          },
        });
      } catch (e) {
        return { ok: false, status: 0, message: e instanceof Error ? e.message.slice(0, 120) : "network error" };
      }
      expiry = res.headers.get("github-authentication-token-expiration") ?? expiry;
      if (!res.ok) {
        let message = "";
        try { message = String(((await res.json()) as { message?: string }).message ?? "").slice(0, 160); } catch { /* not JSON */ }
        return { ok: false, status: res.status, message };
      }
      return { ok: true, data: (await res.json()) as T };
    },
  };
}

/** Days until the token expires, or null when unknown. Negative means already expired. */
export function daysLeft(expiry: string | null, nowMs: number): number | null {
  if (!expiry) return null;
  const t = Date.parse(expiry);
  return Number.isNaN(t) ? null : Math.floor((t - nowMs) / 86_400_000);
}
