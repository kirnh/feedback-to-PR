# feedback-to-PR

Turns in-app feedback into scoped GitHub issues, and labeled issues into draft pull requests with a preview build. Portable: one engine, a small config per repo, an adapter per platform.

```
app feedback box -> triage (Claude) -> GitHub issue -> you add `ai-fix` -> fix agent -> draft PR -> CI + preview build -> you merge
```

## Layers
| Layer | Where | Changes per repo? |
|---|---|---|
| Engine | `.github/workflows/`, `prompts/`, `intake/` | No |
| Repo config | `harness.config.yml` in the app repo | Yes |
| App adapter | `intake/clients/<platform>` | Per platform |

## Status
- [x] Phase 1: fix agent, guardrails, config, installer
- [ ] Phase 1b: preview builds (see `previews/`, approach to be chosen for bare React Native)
- [ ] Phase 2: triage Worker and feedback box (beta users only)
- [ ] Phase 3: auto-approve safe issue types

## Install into an app repo
```
scripts/init.sh /path/to/app OWNER
```
Then follow the printed steps. Tag this repo `v1` so consumers can pin to it.

## Safety rules
- Feedback text never reaches a code-writing agent without a human label in between.
- AI branches (`ai/*`) fail CI if they touch `protected_paths` or `.github/`.
- The agent is capped by `agent.max_turns` and a 30 minute job timeout, and opens draft PRs only.
- Branch protection on `main` is what stops a merge. The agent cannot approve its own PR.
