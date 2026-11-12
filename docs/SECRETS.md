# Keys and secrets

<!-- Generated from secrets.manifest.json by `node scripts/secrets.mjs doc`. Do not edit by hand; a test checks it is up to date. -->

Every key lives in **GitHub secrets**. You set them all with one command, `node scripts/secrets.mjs set <ID>`, and see them all with `node scripts/secrets.mjs list`. A GitHub job (`deploy-worker`) copies the Worker's keys to Cloudflare, because the Worker cannot read GitHub secrets itself. Values are never shown, printed or written to a file.

Harness repo: `kirnh/feedback-to-PR`. Apps: `kirnh/MediSync`.

## Deploy key

Stored only as a GitHub secret of the harness repo.

### `CLOUDFLARE_API_TOKEN`

Lets GitHub deploy the Worker and copy the other keys to Cloudflare. It is the one key that cannot be copied for you.

- **Used by:** The deploy-worker workflow (GitHub Actions)
- **How to get it:** Cloudflare dashboard > My Profile > API Tokens > Create Token > use the template 'Edit Cloudflare Workers' > account: yours > Continue > Create. Copy the token once, with the Copy button (an Account API token from Manage Account works too).
- **Set it:** `node scripts/secrets.mjs set CLOUDFLARE_API_TOKEN`

## Cloudflare Worker keys

Stored as GitHub secrets of the harness repo, then copied to Cloudflare under the name shown in brackets.

### `WORKER_SIGNING_KEY` (Cloudflare: `SIGNING_KEY`)

Signs one-tap approval links, dashboard sign-in cookies and tester beta codes. Random; you never type it.

- **Used by:** Worker: /v1/approve; Worker: dashboard sign-in; Worker: beta codes; App repos, as APPROVAL_SIGNING_KEY, to make approval links
- **How to get it:** Generated for you.
- **Set it:** `node scripts/secrets.mjs set WORKER_SIGNING_KEY`
- **Also sets** `APPROVAL_SIGNING_KEY` in every app repo

### `WORKER_GITHUB_TOKEN` (Cloudflare: `GITHUB_TOKEN`)

Lets the Worker add the ai-fix label, file issues from feedback, and read pull requests and runs for the dashboard.

- **Used by:** Worker: approvals; Worker: feedback intake; Worker: dashboard
- **How to get it:** GitHub > Settings > Developer settings > Fine-grained tokens > Generate. Owner: you. Repositories: only the app repos. Permissions: Issues Read and write, Pull requests Read, Actions Read. Pick an expiry and note it.
- **Set it:** `node scripts/secrets.mjs set WORKER_GITHUB_TOKEN`
- **Expires:** meant to last 7 days; `list` warns before then

### `WORKER_DASHBOARD_PASS` (Cloudflare: `DASHBOARD_PASS`) (optional)

Protects the dashboard. Only a salted hash is stored, never the passphrase itself.

- **Used by:** Worker: dashboard sign-in
- **How to get it:** You choose it: at least ten characters, for example four random words.
- **Set it:** `node scripts/secrets.mjs set WORKER_DASHBOARD_PASS`

### `WORKER_TRIAGE_LLM_KEY` (Cloudflare: `TRIAGE_LLM_KEY`) (optional)

Lets the AI turn a tester's message into a clean, anonymous issue. Without it, feedback from the app cannot be processed.

- **Used by:** Worker: feedback intake
- **How to get it:** Your Anthropic key from console.anthropic.com > API keys (the same key as the agent's is fine), or a key for another provider set in wrangler.toml.
- **Set it:** `node scripts/secrets.mjs set WORKER_TRIAGE_LLM_KEY`

### `WORKER_NTFY_PROGRESS_TOPIC` (Cloudflare: `NTFY_PROGRESS_TOPIC`) (optional)

Private ntfy channel for quiet progress messages such as 'Approved, starting' and 'Done'. The topic name is its own password.

- **Used by:** Worker: acknowledgements; App repos, as NTFY_PROGRESS_TOPIC, for 'Done' messages
- **How to get it:** Generated for you. Then subscribe to the name it prints in the ntfy app.
- **Set it:** `node scripts/secrets.mjs set WORKER_NTFY_PROGRESS_TOPIC`
- **Also sets** `NTFY_PROGRESS_TOPIC` in every app repo

### `WORKER_VAPID_PRIVATE_JWK` (Cloudflare: `VAPID_PRIVATE_JWK`) (optional)

Lets the Worker send push notifications to the installed web app. Only needed for the push test and the future installable dashboard.

- **Used by:** Worker: push test
- **How to get it:** Generated for you.
- **Set it:** `node scripts/secrets.mjs set WORKER_VAPID_PRIVATE_JWK`

## Keys each app repo needs

Stored as secrets of each app repo. GitHub shows a repo's secrets only to that repo, so an app needs its own copy.

### `ANTHROPIC_API_KEY`

Lets the AI agent write the change for an issue. Each app repo needs its own copy, because GitHub shows a repo's secrets only to that repo.

- **Used by:** App repos: the fix workflow (agent run and preflight); doctor --remote
- **How to get it:** console.anthropic.com > API keys > Create key. Set a monthly spend limit.
- **Set it:** `node scripts/secrets.mjs set ANTHROPIC_API_KEY`

### `NTFY_TOPIC` (optional)

Private ntfy channel for messages that need you: Approve fix?, PR ready, Run failed. The topic name is its own password.

- **Used by:** App repos: approval request and result messages
- **How to get it:** Make up a long random name (at least 16 characters) and subscribe to it in the ntfy app.
- **Set it:** `node scripts/secrets.mjs set NTFY_TOPIC`

### `APPROVAL_SIGNING_KEY` (optional)

A copy of the signing key so the app's workflow can make one-tap approval links. Set automatically whenever the signing key is set.

- **Used by:** App repos: approval request message
- **How to get it:** Not set by hand.
- **Set by:** `WORKER_SIGNING_KEY`, automatically

### `NTFY_PROGRESS_TOPIC` (optional)

A copy of the progress topic so the fix workflow can send 'Done'. Set automatically with the Worker's topic.

- **Used by:** App repos: 'Done' message
- **How to get it:** Not set by hand.
- **Set by:** `WORKER_NTFY_PROGRESS_TOPIC`, automatically

### `HARNESS_TOKEN` (optional)

Only needed if the harness repo is private: lets an app's workflows fetch the harness scripts. The harness repo is public today, so this is not set.

- **Used by:** App repos: fix and approval workflows, to download the harness
- **How to get it:** GitHub > Settings > Developer settings > Fine-grained tokens > read-only access to the harness repo.
- **Set it:** `node scripts/secrets.mjs set HARNESS_TOKEN`
