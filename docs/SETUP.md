# Setup guide

How to put feedback-to-PR in front of any app repo. There are three parts: the harness repo (once), the approval Worker (once, optional), and the app repo (once per app).

| Part | Needed for | Time |
|---|---|---|
| A. Harness repo | Everything | 5 min |
| B. App repo | Issue → draft PR | 15 min |
| C. Approval Worker + ntfy | One-tap phone approval and notifications | 20 min |

You can stop after B: add the `ai-fix` label by hand and you get draft PRs.

## Prerequisites
- A GitHub account/org that hosts this repo (the **harness repo**, expected name `feedback-to-PR`) and the app repo
- An API key for your agent: Anthropic for `claude-code`, or a provider key for `aider`
- A Node-based app with lint, type-check and test commands (a check the app lacks can be `true`)
- For part C: a Cloudflare account, Node 22, and the free ntfy iOS/Android app

## A. Harness repo
1. Push this repo to GitHub as `<owner>/feedback-to-PR`. The caller templates assume this name; if you use another, edit the `uses:` lines or pass `harness_repository`.
2. If the repo is **private**, create a fine-grained token with read access to it and keep it for `HARNESS_TOKEN` below. Also enable *Settings → Actions → General → Access* so other repos in the owner can use its workflows.

## B. App repo

### B1. Install files
```bash
scripts/init.sh /path/to/app OWNER
```
This writes, skipping any file that already exists:
- `.github/workflows/ai-fix.yml`, `ai-guardrails.yml`, `ai-approval-notify.yml` (with `OWNER` filled in)
- `harness.config.yml` copied from `harness.config.example.yml`

### B2. Edit `harness.config.yml`
Set `project`, the four `commands`, `protected_paths` and `node_version`. Choose the runner. Field reference: [API.md](API.md#3-harnessconfigyml). Example for a React Native app:

```yaml
project: MyApp
commands:
  install: yarn install --frozen-lockfile
  lint:    yarn lint
  types:   yarn tsc --noEmit
  test:    yarn test --ci
protected_paths:
  - ios/**/*.pbxproj
  - android/app/build.gradle
  - android/**/*.keystore
  - app.json
node_version: 22
agent:
  runner: claude-code
  model: ""
  max_turns: 25
instructions: CLAUDE.md
```

Add a `CLAUDE.md` (or the file named in `instructions`) describing your components, design tokens, test style and accessibility rules. The agent reads it first; the better it is, the better the PRs.

### B3. GitHub settings
1. **Secrets** (Settings → Secrets and variables → Actions): `ANTHROPIC_API_KEY` (or the key for your provider). Optional: `HARNESS_TOKEN`, and the part-C secrets.
2. **Actions permission** (Settings → Actions → General): enable *Allow GitHub Actions to create and approve pull requests*.
3. **Labels**: create `ai-fix` and `ai-triaged`.
   ```bash
   gh label create ai-fix -R OWNER/app --color 0E8A16
   gh label create ai-triaged -R OWNER/app --color FBCA04
   ```
4. **Branch protection on `main`**: require the CI checks, the `AI guardrails` check, and 1 approving review. This is what actually stops a merge; guardrails are only advisory without it.
5. Commit and push the workflow files and config to the default branch (issue-triggered workflows run from the default branch).

### B4. Smoke test
1. Open an issue describing a small, concrete change.
2. Add the `ai-fix` label.
3. Watch *Actions → AI fix*. In roughly 5–20 minutes expect: a draft PR on `ai/issue-<n>`, a before/after checks table in its body, and a "Judgement trace" comment on the issue.
4. If the agent changed nothing, the issue gets a comment saying so; make the issue more specific and re-label (remove then add `ai-fix`).

## C. Approval Worker and phone notifications

### C1. Pick ntfy topics
Generate two long random topic names and subscribe to both in the ntfy app (set the progress topic to low priority/quiet):
```bash
echo "f2pr-act-$(openssl rand -hex 16)"
echo "f2pr-prg-$(openssl rand -hex 16)"
```
A topic name is the only access control on ntfy.sh, so treat it like a password. For stronger privacy, self-host ntfy and set `ntfy_server` / `NTFY_SERVER`.

### C2. Deploy the Worker
```bash
cd server
npm install
npm test                     # token, approve, ntfy and push tests
npx wrangler login
npx wrangler kv namespace create USED      # paste the printed id into wrangler.toml
```
Edit `server/wrangler.toml`:
- `ALLOWED_REPOS` → comma-separated list of every `owner/repo` you will serve
- `[[kv_namespaces]] id` → your KV id
- `VAPID_SUBJECT` in `src/push.ts` only matters for the push test; ignore otherwise

Create the GitHub token: *Settings → Developer settings → Fine-grained tokens*, resource owner = the owner of the app repos, repositories = only the allowed ones, permission **Issues: Read and write**, nothing else.

Set secrets and deploy:
```bash
SIGNING_KEY=$(openssl rand -hex 32); echo "$SIGNING_KEY"   # keep this value for C3
echo "$SIGNING_KEY"                | npx wrangler secret put SIGNING_KEY
npx wrangler secret put GITHUB_TOKEN          # paste the fine-grained token
npx wrangler secret put NTFY_PROGRESS_TOPIC   # the progress topic
npx wrangler deploy
curl https://feedback-to-pr.<subdomain>.workers.dev/v1/health    # {"ok":true}
```

### C3. Wire the app repo
Add repo secrets: `NTFY_TOPIC` (needs-you topic), `NTFY_PROGRESS_TOPIC`, and `APPROVAL_SIGNING_KEY` (the exact `SIGNING_KEY` value). In `.github/workflows/ai-approval-notify.yml` set `worker_url` to your Worker URL.

### C4. Test the loop
1. Open an issue and add `ai-triaged`.
2. Your phone shows **Approve fix?** with Approve / Reject / View issue.
3. Tap Approve: within about a second the progress topic says **Approved, starting**, the issue gains `ai-fix`, and the fix run begins.
4. On completion: **PR ready** (needs-you) and **Done** (progress).

### C5. Dashboard (optional)
1. Edit the Worker's fine-grained token (GitHub → Settings → Developer settings → Fine-grained tokens) and add **Pull requests: Read** and **Actions: Read**. No new token or secret is needed.
2. Choose a passphrase: `cd server && node scripts/set-dashboard-passphrase.mjs`. You type it twice (hidden); only a salted hash is stored, and the script signs in once to prove it works.
3. Open `https://<worker>/app/`. In each app repo's `ai-fix.yml`, the run must be named `AI fix #<issue number>` (`run-name: AI fix #${{ github.event.issue.number }}`, already in the template) so the dashboard can link runs to issues.

## Adding more apps
For each additional app: run `init.sh`, edit its config, add its secrets, labels and branch protection (part B), add its `owner/repo` to `ALLOWED_REPOS` and give the Worker's GitHub token access to it, then `npx wrangler deploy` (part C). The Worker and topics are shared. If you want per-app topics, use separate `NTFY_TOPIC` secrets per repo; the Worker's progress topic is global.

## Switching models
Edit `agent.runner` and `agent.model` in `harness.config.yml`; no workflow change. For aider examples: `openrouter/deepseek/deepseek-chat` with `OPENROUTER_API_KEY`, `gpt-4o` with `OPENAI_API_KEY`, `gemini/gemini-2.0-flash` with `GEMINI_API_KEY`. To compare models, run the same issue under each runner and compare the PRs and traces.

## Upgrading and pinning
Templates track `@main`, so a harness change affects every app on its next run. Once stable, tag a release and change both the `uses: ...@main` ref and `harness_ref:` in the app's workflow files to the tag. The trace records the harness SHA used for every run.

## Local development of the Worker
```bash
cd server
npm run typecheck && npm test
npx wrangler dev                 # local Worker; put secrets in server/.dev.vars (git-ignored)
```
Test notification payloads without sending: `NTFY_DRY_RUN=1 bash scripts/ntfy-send.sh topic "Title" "Message" tada 3`.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Labeling `ai-fix` does nothing | Workflow files are not on the default branch, or `OWNER` in `uses:` is wrong, or a private harness lacks Actions access |
| `harness.config.yml missing` | Config must be at the app repo root on the branch checked out |
| PR creation fails | Enable "Allow GitHub Actions to create and approve pull requests" |
| Agent step fails immediately | Missing or wrong `ANTHROPIC_API_KEY` / provider key |
| "finished without changing any files" | Issue too vague, or needs a product decision (the prompt tells the agent to stop and ask) |
| Guardrails fail on an AI PR | The agent touched a protected path; fix the issue wording or the config |
| No approval notification | `NTFY_TOPIC` or `APPROVAL_SIGNING_KEY` missing (job logs a notice and skips), or issue lacks `ai-triaged` |
| Tap returns `bad_signature` (401) | `APPROVAL_SIGNING_KEY` in the repo differs from the Worker's `SIGNING_KEY` |
| `repo_not_allowed` (403) | Add the repo to `ALLOWED_REPOS` and redeploy |
| `github_error` (502) | Token lacks Issues write on that repo or expired; see Worker logs (Cloudflare → Observability), which record GitHub's status and message |
| `already_used` / `expired` | Re-trigger by removing and re-adding `ai-triaged` to mint fresh links |
| No "Approved, starting" message | `NTFY_PROGRESS_TOPIC` not set on the Worker (the approval still worked) |
| iPhone shows raw symbols | Notification text must be plain text; do not add markdown |
