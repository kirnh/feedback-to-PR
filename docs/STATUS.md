# Status: milestone 0.1 (11 November 2026)

A labeled GitHub issue becomes a draft pull request made by an AI agent, with a one-tap phone approval. The core loop works end to end on a real app. Both ends of the loop (collecting feedback in the app, trying the result on a phone) and the setup experience are not built yet.

This page separates **proven live** from **built but not yet proven** from **not built**. Design lives in [ARCHITECTURE.md](ARCHITECTURE.md), interfaces in [API.md](API.md), install steps in [SETUP.md](SETUP.md).

## 1. Where each piece stands

| Area | State | Evidence |
|---|---|---|
| Issue → draft PR with before/after checks | **Proven live** | Run 42589830374 on `kirnh/MediSync`: Sonnet 5.5, 9 turns, about $0.10, PR #2 opened, re-run updated the same PR |
| Judgement trace (issue comment + `trace.json`) | **Proven live** | Same run: approval, model, cost, checks before and after, files |
| One-tap approval from a phone | **Proven live** | Issue #3: tap → Worker `200` → label `ai-fix` → fix run started. A second tap was refused (`409`) |
| Approval Worker (signed, expiring, single-use links) | **Proven live, tested** | 89 automated tests; forged, expired, replayed and wrong-repo links all refused |
| Guardrails (block `ai/*` PRs touching protected paths) | Built, **never verified blocking** | Workflow ran once and stopped at `action_required`; the fork has no branch protection, so it is advisory |
| "Approved, starting", "PR ready", "Done", "Run failed" messages | Built and dry-run tested, **never run live** | Needs `NTFY_PROGRESS_TOPIC` set on the Worker and the fork (not set) |
| Web push (foundation for the dashboard) | **Server side proven, iPhone not yet** | Worker → Apple push service answered `201`; five seconds later the MacBook page recorded being opened from a notification. iPhone test is next |
| Owner dashboard | Mock only | `dashboard/mock.html` (example data) |
| Feedback box, intake API, triage AI | Not built | |
| Preview builds on a phone | Not started | |
| Cheaper or other models | `aider` runner written, **untested** | |
| Scoped checks (only judge what changed) | Not built | All three checks already fail on MediSync's `main` |
| `init` / `doctor` commands, automated end-to-end tests | Not built | Setup is manual today |

## 2. What is deployed

| Thing | Where |
|---|---|
| Harness repo | `github.com/kirnh/feedback-to-PR` (public) |
| Test app | `kirnh/MediSync`, a private fork of an upstream the owner does not control. App source is never modified by us |
| Approval Worker | `https://feedback-to-pr.feedback-to-pr-server.workers.dev` (Cloudflare account of the owner), KV namespace `USED`, static assets under `/push-test/` |

Secret **names** (values are never written anywhere in the repo):

| Where | Set | Not set |
|---|---|---|
| Worker | `SIGNING_KEY`, `GITHUB_TOKEN`, `VAPID_PRIVATE_JWK` | `NTFY_PROGRESS_TOPIC` |
| Fork (`kirnh/MediSync`) | `ANTHROPIC_API_KEY`, `APPROVAL_SIGNING_KEY`, `NTFY_TOPIC` | `NTFY_PROGRESS_TOPIC` |

**Expiry to watch:** the Worker's `GITHUB_TOKEN` was set up on 11 November with the 7-day expiry the setup steps called for (check the exact date under GitHub → Settings → Developer settings). Approvals will start failing at expiry, expected around **18 November**, unless it is renewed.

## 3. Measured facts (not assumptions)

**ntfy on iPhone** (probed on the owner's phone):

| Feature | Works? |
|---|---|
| Emoji tags | Yes |
| Action buttons `view` and `http` | Yes. `http` gives no visible feedback when tapped |
| Inline image attachment | Yes |
| Delayed delivery | Yes |
| Clear and replace-in-place | Only after the app refreshes, not live |
| Markdown | No, shows raw symbols |
| `copy` button, notification icon | No |

**Web push:** iPhone requires the page to be installed on the Home Screen; the badge API and push API are present on the owner's iPhone (iOS 18.7). Cloudflare Workers can send standards-compliant push (`aes128gcm` + VAPID); an older library version that used the legacy encoding was rejected by Apple, so the pinned library is v2.

**MediSync CI:** `package-lock.json` is stale and `yarn.lock` (Yarn 3) is the real lockfile; install uses `corepack` with `yarn@3.8.7`. Lint, type-check and Jest already fail on `main` (Deno functions, a native Realm module), so only the before/after comparison in a PR is meaningful.

**GitHub:** environment required-reviewers is unavailable on a free-plan private repo, which is why approval uses signed links instead.

## 4. Known issues and open items

1. **A fix run failed and its cause is not known.** Run 42960507640 (issue #3): the agent step ended after 199 ms with 1 turn, $0 and no model used, reporting `success` with `is_error: true`. The request was rejected before any model ran, most likely an account, key or billing problem on the API side. The log does not include the message. Action: make the harness print the result text on failure, then re-run.
2. **Acknowledgements are skipped** until `NTFY_PROGRESS_TOPIC` is set (on both the Worker and the fork).
3. **Guardrails are advisory** on the fork until branch protection requires the `AI guardrails` check.
4. **Engine changes reach every app immediately** (`harness_ref` defaults to `main`). Pin a tag once stable.
5. **No rate limit on `/v1/approve`** beyond token validity.
6. **`id-token: write` is still granted** to the fix job; whether it is needed is untested.
7. **`VAPID_SUBJECT` in `server/src/push.ts` is hardcoded** to the owner's Worker URL (push test only).
8. **Setup is manual and error-prone.** A key passed through the clipboard was overwritten and stored as the wrong value. This is a product gap, not a user error (section 6).
9. **Docs provenance:** `docs/ARCHITECTURE.md`, `API.md` and `SETUP.md` appeared in the repo on 11 November at 10:52 without a recorded author. They were checked against the code on the day of this milestone and corrected where wrong.

## 5. Decisions and why

| Decision | Reason |
|---|---|
| GitHub is the database (issues, labels, PRs, trace comments) | No separate store to run or secure; works from GitHub Mobile |
| Approval by signed single-use link, not a token in the notification | A credential must never travel through a third-party relay |
| Harness owns branch, checks, commit and PR; the agent only edits files | Any model or runner is held to the same standard |
| Draft PRs only, human merges | The agent cannot approve its own work |
| Move from ntfy to an installable web app with its own push | Live feedback on every tap, one inbox, branding, no extra app. ntfy stays as an optional channel |
| Passphrase login for the dashboard first; approve and reject only | Smallest safe version; merge stays on GitHub where the diff is visible |

## 6. What "serious" requires next

Setup and verification must not depend on the owner experimenting.

1. Diagnose and fix the failed run; print failure reasons in the run itself.
2. `doctor` (checks every link end to end and names the fix) and `init` (installs, stores secrets with self-verification, finishes with a pass/fail summary).
3. Automated end-to-end tests against a throwaway repo and a preview Worker, so changes are proven before they reach anyone's account.
4. Platform findings go into a support matrix (section 3) so users never run probes.
5. Finish the iPhone push test (the page now reports its own results), then build the dashboard: read-only, then approve and reject, then installable with push.
6. Scope the checks to what changed.
7. Intake and triage, with a swappable model.

## 7. Quality gate at this milestone

- 89 automated tests pass (`cd server && npm test`); `tsc --noEmit` is clean
- All workflow and config YAML parses; every shell script passes `bash -n`
- Notification payloads verified with `NTFY_DRY_RUN=1` for every outcome
