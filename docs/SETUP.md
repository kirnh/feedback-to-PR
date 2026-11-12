# Setup

## One time (harness)
1. Fork or clone this repo. Edit `secrets.manifest.json` (`harnessRepo`, `apps`, `cloudflareAccountId`, `worker`) and `server/wrangler.toml` (`ALLOWED_REPOS`, `PROJECTS`).
2. Create a Cloudflare KV namespace named `USED` and put its id in `wrangler.toml`.
3. `node scripts/secrets.mjs setup` walks through every key, one at a time, hidden input, each checked before it is stored. Start with the Cloudflare deploy token: after that, GitHub deploys the Worker and copies its keys for you.
4. `node scripts/doctor.mjs --repo OWNER/APP --worker https://<your-worker>.workers.dev --remote`

## Per app
1. `scripts/init.sh /path/to/app OWNER` copies the caller workflows (`ai-fix`, `ai-ready`, `ai-guardrails`, `ai-doctor`) and `harness.config.yml`. Edit the config (project name, install/lint/types/test commands, protected paths). Commit to the default branch.
2. In the app repo: Settings > Actions > General > allow Actions to create pull requests. Create labels `ai-triaged` and `ai-fix`. Optional: branch protection requiring the `AI guardrails` check and one review.
3. Turn on GitHub mobile notifications. They are how you hear that something needs approval.
4. `node scripts/secrets.mjs list` should show every required key set. `node scripts/send-test-feedback.mjs` sends one message through the whole intake.

## Daily use
You get a GitHub notification: "new feedback is ready". Add the label `ai-fix` to approve, or close the issue. Later: a notification with the draft PR. Review and merge, or comment what to change.
