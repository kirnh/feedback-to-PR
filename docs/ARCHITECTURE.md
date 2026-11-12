# Architecture

## Parts
| Part | Where | Job |
|---|---|---|
| Feedback box | in the beta app (not built yet) | sends `POST /v1/feedback` with a message and a little context |
| Worker | Cloudflare (`server/`) | rewrites the message into a short anonymous issue with a triage model and files it; the original text is never stored on GitHub |
| Ready notice | `templates/ai-ready.yml` in each app repo | when an issue gets `ai-triaged`, the Actions bot comments and @-mentions the owner so GitHub notifies them |
| Fix workflow | `.github/workflows/fix-issue.yml` (reusable) | runs only when the owner adds `ai-fix`; the agent edits files, the harness owns branch, checks, commit and draft PR |
| Guardrails | `.github/workflows/guardrails.yml` | blocks agent PRs that touch protected paths |
| Doctor | `scripts/doctor.mjs`, `doctor.yml` | checks every link and prints the exact fix |
| Keys | `secrets.manifest.json`, `scripts/secrets.mjs`, `deploy-worker.yml` | all keys live in GitHub secrets; a job copies the Worker's keys to Cloudflare |

## Flow
1. Tester sends feedback. The Worker triages it (create, duplicate of an open issue, or reject) and files an issue labeled `ai-triaged`.
2. The Actions bot @-mentions the owner. **Approval 1:** the owner adds the label `ai-fix` in GitHub (web or mobile). Close the issue to reject. The workflow runs only if the actor is the repo owner.
3. The agent drafts a PR. Checks run before and after, so a failure the PR introduced is told apart from one already on the base branch. A judgement trace (who approved, model, cost, checks) is posted on the issue.
4. The bot comments on the issue with the PR link. **Approval 2:** the owner reviews and merges the PR.

## Security model
- Nothing runs without the owner adding `ai-fix`. The intake can at worst create issues, bounded by 5 messages per device per hour and 50 per project per day.
- There is no login on the intake: the app names its project in `X-Project`. The Worker only knows projects listed in `wrangler.toml` and only files issues in allowed repos.
- Tester text is untrusted: HTML, links, mentions and issue references are stripped, the model's answer is validated, and the issue never contains the original message.
- The Worker's GitHub token has Issues access only. The agent's workflow token is the job's own.
- No key is ever printed, committed or passed through the clipboard (`scripts/secrets.mjs`).

## Model-agnostic
Triage: `TRIAGE_PROVIDER` / `TRIAGE_MODEL` in `wrangler.toml` (anthropic or any openai-compatible endpoint). Agent: `agent.runner` / `agent.model` in the app's `harness.config.yml` (`claude-code`, or `aider` for other providers, untested).
