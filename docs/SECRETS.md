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

### `WORKER_GITHUB_TOKEN` (Cloudflare: `GITHUB_TOKEN`)

Lets the Worker file an issue from each piece of feedback (and note duplicates).

- **Used by:** Worker: feedback intake
- **How to get it:** GitHub > Settings > Developer settings > Fine-grained tokens > Generate. Owner: you. Repositories: only the app repos. Permissions: Issues Read and write (nothing else). Pick an expiry of 30 days or more and note it.
- **Set it:** `node scripts/secrets.mjs set WORKER_GITHUB_TOKEN`
- **Expires:** meant to last 30 days; `list` warns before then

### `WORKER_TRIAGE_LLM_KEY` (Cloudflare: `TRIAGE_LLM_KEY`)

Lets the AI turn a tester's message into a clean, anonymous issue. Without it, feedback from the app cannot be processed.

- **Used by:** Worker: feedback intake
- **How to get it:** Your Anthropic key from console.anthropic.com > API keys (the same key as the agent's is fine), or a key for another provider set in wrangler.toml.
- **Set it:** `node scripts/secrets.mjs set WORKER_TRIAGE_LLM_KEY`

## Keys each app repo needs

Stored as secrets of each app repo. GitHub shows a repo's secrets only to that repo, so an app needs its own copy.

### `ANTHROPIC_API_KEY`

Lets the AI agent write the change for an issue. Each app repo needs its own copy, because GitHub shows a repo's secrets only to that repo.

- **Used by:** App repos: the fix workflow (agent run and preflight); doctor --remote
- **How to get it:** console.anthropic.com > API keys > Create key. Set a monthly spend limit.
- **Set it:** `node scripts/secrets.mjs set ANTHROPIC_API_KEY`

### `HARNESS_TOKEN` (optional)

Only needed if the harness repo is private: lets an app's workflows fetch the harness scripts. The harness repo is public today, so this is not set.

- **Used by:** App repos: the fix workflow, to download the harness
- **How to get it:** GitHub > Settings > Developer settings > Fine-grained tokens > read-only access to the harness repo.
- **Set it:** `node scripts/secrets.mjs set HARNESS_TOKEN`
