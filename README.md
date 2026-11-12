# feedback-to-PR

Turns labeled GitHub issues into draft pull requests, with phone approval and result notifications. Portable: one engine and a small config per repo.

```
app feedback box -> triage (Claude) -> GitHub issue -> you add `ai-fix` -> fix agent -> draft PR -> CI -> you merge
```

## Documentation
- [**Status (milestone 0.1)**](docs/STATUS.md): what is proven live, what is built but unproven, what is not built, known issues, next steps
- [**Integration plan**](docs/PLAN-integration.md): one-step install, in-app feedback section, before/after clips, micro-release changelog (proposal)
- [System design](docs/ARCHITECTURE.md): components, lifecycle, approval service, security model
- [API and integration reference](docs/API.md): Worker endpoints, reusable workflows, config, secrets, labels
- [Keys and secrets](docs/SECRETS.md): every key, what it is for, where it is used, how to set it (generated)
- [Setup guide](docs/SETUP.md): connect any app repo, deploy the Worker, troubleshooting

## Layers
| Layer | Where | Changes per repo? |
|---|---|---|
| Engine | `.github/workflows/`, `prompts/`, `scripts/` | No |
| Repo config | `harness.config.yml` in the app repo | Yes |

## Status
- [x] Fix pipeline: labeled issue to draft PR, before/after checks, judgement trace (proven live)
- [x] One-tap phone approval through a signed-link Worker (proven live)
- [ ] Result and progress notifications (built, not yet run live)
- [ ] Setup tooling: `init`, `doctor`, automated end-to-end tests (not built)
- [ ] Owner dashboard as an installable web app with its own push (mock exists; server-side push proven, iPhone test next)
- [ ] Preview builds to try each PR on a phone (not started)
- [ ] Phase 2: triage Worker and feedback box (beta users only)
- [ ] Phase 3: auto-approve safe issue types

## Model-agnostic
The agent is a swappable **runner**; the harness owns branch, checks, commit, push and PR for every runner. Pick one in `harness.config.yml`:

| runner | models | notes |
|---|---|---|
| `claude-code` | Claude models | Best-supported path. Needs `ANTHROPIC_API_KEY`. |
| `aider` | Anything LiteLLM supports: OpenAI, Gemini, DeepSeek, OpenRouter, local | Cheaper models. Not yet tested here. Set `model` e.g. `openrouter/deepseek/deepseek-chat` and the matching key secret. |

Planned: the triage step (phase 2) will call any OpenAI-compatible endpoint, so it follows the same rule. To compare models, run the same issue under each runner and compare the PRs.

## Install into an app repo
```
scripts/init.sh /path/to/app OWNER
```
Then follow the printed steps. Templates track `@main` while the harness is changing; pin to a release tag once it settles.

## Phone notifications (ntfy)
Two topics, both private to you (a topic name is effectively a password, so use long random ones):

| Topic | Secret | Carries |
|---|---|---|
| Needs you | `NTFY_TOPIC` | Approve or reject request (one tap), PR ready, run failed, no changes made |
| Progress | `NTFY_PROGRESS_TOPIC` | "Approved, starting" within a second of your tap, "Done" with cost and checks |

Titles read `[Project] #issue · what happened`; emoji tags mark the stage. Built from what the iPhone app was measured to support: emoji tags, `view` and `http` buttons, inline images, delayed delivery. Not used because they did not work on iPhone: markdown, replace-in-place updates, auto-clear, icons, and the `copy` button. Buttons are limited to three per message.

## Judgement trace
Every fix run posts a "Judgement trace" comment on the issue and attaches `trace.json` to the run. It records the chain in order: triage (when the triage service embeds one), who approved by adding `ai-fix`, which runner and model ran with turns and cost, each check's result before vs after the change, and the resulting PR and files. It also records the harness version and a hash of the config and prompts, so a result can be tied to exactly what produced it. The trace is written even when the run fails.

## Safety rules
- Feedback text never reaches a code-writing agent without a human label in between.
- AI branches (`ai/*`) fail CI if they touch `protected_paths` or `.github/`.
- The agent is capped by `agent.max_turns` and a 30 minute job timeout, and opens draft PRs only.
- Branch protection on `main` is what stops a merge. The agent cannot approve its own PR.
