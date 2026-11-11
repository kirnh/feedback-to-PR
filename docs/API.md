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
| Worker secret | `GITHUB_TOKEN` | Fine-grained PAT, **Issues: read and write** on allowed repos only |
| Worker secret | `NTFY_PROGRESS_TOPIC` | Optional; acknowledgements are skipped without it |
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
