# API and integration reference

Everything an external app, script or service can touch: the Worker's HTTP API, the reusable workflow interfaces, the config file, secrets, labels, and the trace format.

Base URL of the Worker: `https://feedback-to-pr.<your-subdomain>.workers.dev` (or your custom domain). All responses are JSON. Errors use one shape:

```json
{ "error": { "code": "expired", "message": "This link has expired." } }
```

## 1. Worker HTTP API

### `GET /v1/health`
Liveness check. Returns `200 {"ok": true}`.

### `POST /v1/approve?t=<token>`
Approve or reject a triaged issue. The action is encoded in the signed token, not the URL. `GET` is rejected on purpose.

| Request | |
|---|---|
| Method | `POST` (anything else → `405`) |
| Query `t` | Approval token (see [Minting a token](#minting-a-token)) |
| Body | None |

Success `200`:
```json
{ "ok": true, "action": "approve", "repo": "owner/app", "issue": 42 }
```

| Status | `code` | Meaning |
|---|---|---|
| 200 | – | Done. `approve` added label `ai-fix`; `reject` closed the issue as not planned |
| 400 | `missing_token` / `malformed` | No `t`, or token not parseable |
| 401 | `bad_signature` | Wrong signing key or tampered token |
| 403 | `repo_not_allowed` | Repo not in `ALLOWED_REPOS` |
| 405 | `method_not_allowed` | Not a POST |
| 409 | `already_used` | Link already spent |
| 409 | `not_open` | Issue is closed |
| 409 | `not_triaged` | Issue lacks label `ai-triaged` |
| 409 | `already_approved` | Issue already has `ai-fix` |
| 410 | `expired` | Past the token expiry |
| 502 | `github_error` | GitHub refused; the message includes its status and reason. The link is **not** spent, so retry works |

Side effects on success, after the GitHub change: the nonce is stored in KV, an acknowledgement is pushed to `NTFY_PROGRESS_TOPIC` (if set), and the issue gets a comment "Approved/Rejected with a one-tap link (link id `xxxxxxxx`)".

### Minting a token
Tokens are minted outside the Worker with the shared key, so the Worker never needs an inbound call to create a link.

```bash
SIGNING_KEY=... scripts/mint-approval-link.sh owner/app 42 approve 86400
# prints: <payload>.<signature>
curl -X POST "https://feedback-to-pr.example.workers.dev/v1/approve?t=$(...)"
```

Format: `base64url(JSON{r,i,a,e,n}) . base64url(HMAC-SHA256(that first part, SIGNING_KEY))`. Fields: `r` owner/repo, `i` issue number, `a` `approve|reject`, `e` expiry (unix seconds), `n` random nonce of 8–64 characters. A TypeScript implementation is in `server/src/token.ts` (`sign`, `verify`) if you are minting from your own backend.

### Feedback intake: `POST /v1/feedback`, `GET /v1/feedback/{id}`
The contract is `spec/openapi.yaml` (a test keeps it in step with the code). Auth is a **beta code** as a Bearer token, bound to one project.

- `POST /v1/feedback` with `{"message": "...", "context": {app_version, platform, os, device, screen, locale}}` returns **`202 {id, status: "received"}`** at once; triage runs in the background. Send an `Idempotency-Key` when retrying so one message is never filed twice. Errors: `400 empty_message | bad_json | too_large`, `401 missing_code | invalid_code | expired | revoked | unknown_project`, `429 slow_down` (10 per tester per hour) `| project_limit` (200 per project per day).
- `GET /v1/feedback/{id}` returns `{id, status}` with status `received | triaged | duplicate | rejected | failed`. Only the tester who sent it can read it; anyone else gets `404`. A message still `received` after 5 minutes is reported as `failed`. The GitHub issue is never revealed to testers.
- What happens to the message: it is cleaned (no HTML, hidden comments, links, mentions or issue references), a model rewrites it into a short anonymous issue (or marks it duplicate of an open issue, or rejects it), and **the original text is not stored on GitHub**. The issue carries the label `ai-triaged` and a hidden `<!-- f2pr-trace:triage ... -->` record that the judgement trace picks up. The model output is validated; an unusable answer is retried once, then the message is marked `failed` and shown on the dashboard under Problems.
- The model is a setting, not code: `TRIAGE_PROVIDER` (`anthropic` or `openai-compatible`), `TRIAGE_MODEL`, `TRIAGE_BASE_URL` in `wrangler.toml`; the key is the Worker secret `TRIAGE_LLM_KEY`.
- Projects are declared in the `PROJECTS` variable (`{"<id>": {"repo": "owner/name", "name": "Display name"}}`), and the repo must also be in `ALLOWED_REPOS`.

### Beta codes: `POST /v1/beta-codes`, `POST /v1/beta-codes/revoke`
Owner only (dashboard sign-in cookie). `{"project", "tester", "days"}` (1 to 90, default 30) returns `{code, expiresAt}`; the dashboard has an "Invite a tester" form for this. A code is signed, bound to one project, expires, and carries only a label you choose. `revoke` with `{"code"}` stops a code working immediately.

### Dashboard: `POST /v1/session`, `POST /v1/session/logout`, `GET /v1/dashboard`
Read-only owner dashboard; the page is served at `/app/`.

- `POST /v1/session` with `{"passphrase": "..."}` → `200` and an `HttpOnly`, `Secure`, `SameSite=Strict` cookie valid 30 days. `401 wrong_passphrase`, `429 too_many_attempts` (5 wrong tries per client per 10 minutes), `503 not_configured` if no passphrase is set.
- `GET /v1/dashboard` (cookie required, else `401 login_required`) → `{generatedAt, repos, items[], totals{counts, spentUsd, windowDays}, problems[], activity[], health}`. Cached 45 s; `?fresh=1` bypasses the cache.
- An item is one issue labeled `ai-triaged` or `ai-fix`, with `stage` = `need | run | review | fail | done | rejected`, its PR and run when known, and the embedded trace (`approver`, `model`, `cost`, `turns`, `checks`, `introduced`, `files`). Runs are linked to issues by their name `AI fix #<n>`; PRs by branch `ai/issue-<n>`.
- Each GitHub data source fails independently: a missing token permission appears in `problems` with the fix, and the rest still loads.
- Approval attempts that carried a token are logged (last 60, 30 days) and 401/403/5xx ones appear as problems. The payload never contains tokens, link contents or the passphrase hash.

### `GET /v1/push/key`, `POST /v1/push-test/send`, `POST /v1/push-test/report`, `GET /v1/push-test/results`
Temporary routes for the web-push feasibility test (installed home-screen page → Worker → push service). Not part of the stable API; they will be removed or replaced when the dashboard ships. `results` returns what the phone's service worker reported (push shown, tap opened the app, badge set) so nobody has to answer questions. `key` and `send` return `503 not_configured` unless `VAPID_PRIVATE_JWK` is set; the message says whether the secret is missing, empty or malformed, without revealing it. `send` validates that the subscription endpoint is a real push service, accepts `delay` 0–20 s and `badge` 0–99, and allows one send per 3 s.

## 2. Reusable workflow interfaces

Call these from the app repo (the `init.sh` installer writes the callers for you). Reference them as `OWNER/feedback-to-PR/.github/workflows/<file>@main`.

### `fix-issue.yml`

| Input | Required | Default | |
|---|---|---|---|
| `issue_number` | yes | – | Issue to work on |
| `harness_repository` | no | `<repo owner>/feedback-to-PR` | Where to fetch scripts and prompts |
| `harness_ref` | no | `main` | Tag or branch of the harness. Pin a tag once stable |

| Secret | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | `claude-code` runner; also aider with Claude models |
| `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` | aider with those providers |
| `HARNESS_TOKEN` | Only if the harness repo is private (read access) |
| `NTFY_TOPIC`, `NTFY_PROGRESS_TOPIC` | Optional phone notifications |

Trigger (in the app repo): `issues: labeled` with `if: github.event.label.name == 'ai-fix'`.
Output: branch `ai/issue-<n>`, a draft PR, an issue comment with the trace, and a `trace` artifact.

### `guardrails.yml`
No inputs. Trigger on `pull_request`. Only acts when the head branch starts with `ai/`. Fails if any changed file matches `protected_paths`, `.github/**` or `harness.config.yml`. Add its job name to required status checks in branch protection.

### `notify-approval.yml`

| Input | Required | Default | |
|---|---|---|---|
| `issue_number` | yes | – | |
| `title` | yes | – | Shown in the notification |
| `issue_url` | yes | – | Target of "View issue" |
| `worker_url` | yes | – | Base URL of your deployed Worker |
| `ttl_seconds` | no | `86400` | Link lifetime |
| `ntfy_server` | no | `https://ntfy.sh` | Self-hosted ntfy supported |
| `harness_repository`, `harness_ref` | no | as above | |

Secrets: `NTFY_TOPIC`, `APPROVAL_SIGNING_KEY` (must equal the Worker's `SIGNING_KEY`). If either is missing the job logs a notice and exits successfully.
Trigger: `issues: labeled`, `if: github.event.label.name == 'ai-triaged'`.

## 3. `harness.config.yml`

Lives at the root of the app repo.

| Key | Type | Default | Description |
|---|---|---|---|
| `project` | string | required | Display name used in prompts and notifications |
| `commands.install` | string | required | Install dependencies (e.g. `yarn install --frozen-lockfile`) |
| `commands.lint` | string | required | Lint command; non-zero exit = fail |
| `commands.types` | string | required | Type-check command |
| `commands.test` | string | required | Test command (use CI mode, non-interactive) |
| `protected_paths` | glob list | – | Files an `ai/*` branch may never change. `.github/**` and `harness.config.yml` are always protected |
| `node_version` | number | `22` | Passed to `actions/setup-node` |
| `agent.runner` | `claude-code` \| `aider` | `claude-code` | Which engine edits code |
| `agent.model` | string | runner default | Empty means `claude-sonnet-5-5` for claude-code |
| `agent.max_turns` | number | `25` | Cap on agent steps (claude-code) |
| `instructions` | path | `CLAUDE.md` | Project conventions file the agent reads first |

All three check commands are required, because the before/after comparison runs each one. Use `true` for a check an app does not have.

Glob note: guardrails use shell `case` patterns, where `*` also matches `/`. `ios/**/*.pbxproj` therefore behaves as intended.

## 4. Labels

| Label | Applied by | Effect |
|---|---|---|
| `ai-triaged` | Triage service, or a person | Sends the approval notification; the Worker only acts on issues with it |
| `ai-fix` | The Worker on approve, or a person | Starts the fix run |

Both must exist in the app repo (create them once).

## 5. Secrets and variables

| Where | Name | Purpose |
|---|---|---|
| App repo secret | `ANTHROPIC_API_KEY` (or other provider key) | Agent |
| App repo secret | `NTFY_TOPIC` | Needs-you topic |
| App repo secret | `NTFY_PROGRESS_TOPIC` | Progress topic |
| App repo secret | `APPROVAL_SIGNING_KEY` | Signs approval links (same value as Worker `SIGNING_KEY`) |
| App repo secret | `HARNESS_TOKEN` | Only for a private harness repo |
| Worker secret | `SIGNING_KEY` | Verifies links |
| Worker secret | `GITHUB_TOKEN` | Fine-grained PAT on allowed repos only: **Issues: read and write** (approvals), plus **Pull requests: read** and **Actions: read** (dashboard) |
| Worker secret | `NTFY_PROGRESS_TOPIC` | Optional; acknowledgements are skipped without it |
| Worker secret | `DASHBOARD_PASS` | Salted hash of the dashboard passphrase. Set with `node server/scripts/set-dashboard-passphrase.mjs` (typed hidden, verified by a test sign-in) |
| Worker secret | `TRIAGE_LLM_KEY` | API key for the triage model. Set with `node server/scripts/set-triage-key.mjs` (tested first when the provider is Anthropic) |
| Worker secret | `VAPID_PRIVATE_JWK` | Push test only. Create and store in one step with `node server/scripts/set-vapid-secret.mjs` (never goes through the clipboard) |
| Worker var | `ALLOWED_REPOS` | Comma-separated `owner/repo` allowlist (in `wrangler.toml`) |
| Worker var | `NTFY_SERVER` | Optional, default `https://ntfy.sh` |
| Worker binding | `USED` (KV) | Single-use link records |

## 6. Trace and notification formats

**Trace** (`trace.json`, schema `feedback-to-pr.trace/1`): see the chain table in [ARCHITECTURE.md](ARCHITECTURE.md#6-judgement-trace). Consumers can read it from the run artifact named `trace`. An intake service can contribute a triage stage by putting `<!-- f2pr-trace:triage {"...":"..."} -->` in the issue body.

**ntfy**: messages are POSTed as JSON to the server root (`{topic, title, message, tags, priority, actions, click}`) by `scripts/ntfy-send.sh`. Set `NTFY_DRY_RUN=1` to print the payload instead of sending.

## 7. Integrating an app's feedback source

Until the triage service (phase 2) exists, any producer can feed the pipeline with two GitHub API calls:

```bash
# 1. create the issue
gh issue create -R owner/app --title "Button overlaps text on small screens" --body "<details>"
# 2. mark it a candidate; this sends the approval notification
gh issue edit 123 -R owner/app --add-label ai-triaged
```

Keep issue bodies as plain task descriptions. They are passed to the agent as untrusted text.
