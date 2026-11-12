# Status

Scope was cut on 12 November 2026: GitHub is the whole interface. The dashboard, web push, ntfy and signed approval links were removed. Approval is now the owner adding the `ai-fix` label.

## What exists
| Area | State |
|---|---|
| Issue → draft PR with before/after checks and judgement trace | **Proven live** (PR #4 on `kirnh/MediSync`) |
| Worker: `POST /v1/feedback`, triage AI, issue filing | Built and tested (120 tests); **not yet run with a real model** |
| Approval by label (`ai-fix`, owner only) and the "ready" / result comments | Built; **not yet run live** |
| Keys: one manifest, one command, GitHub secrets as the vault, deploy job copies to Cloudflare | **Proven live** |
| Doctor | Built; run against the fork |
| Guardrails | Built, **never verified blocking** (the fork has no branch protection) |
| `aider` runner for other models | Written, **untested** |

## Not built (in order)
1. Prove the flow once end to end: `node scripts/send-test-feedback.mjs`, add `ai-fix`, review the PR.
2. Feedback box in the app (text box, sends to the Worker).
3. Spike: record before/after screen clips in CI (Android emulator), then attach side by side to the PR.
4. Scoped checks (judge only what the PR changed; all three checks fail on MediSync's `main` today).
5. Reject-with-comment loop (comment on the PR, agent tries again).

## Things to know
- The intake has no login; abuse is bounded by rate limits and nothing runs without your label.
- The Worker's GitHub token expires (30 days recommended). `node scripts/secrets.mjs list` warns before it does.
- MediSync CI: `yarn.lock` (Yarn 3) is canonical, installed through corepack; lint, types and tests already fail on `main`.
- Leftovers from the old design can be deleted: Worker secrets `SIGNING_KEY`, `DASHBOARD_PASS`, `NTFY_PROGRESS_TOPIC`, `VAPID_PRIVATE_JWK`; GitHub secrets `WORKER_SIGNING_KEY`, `WORKER_DASHBOARD_PASS`, `WORKER_NTFY_PROGRESS_TOPIC`, `WORKER_VAPID_PRIVATE_JWK` (harness repo), `NTFY_TOPIC`, `APPROVAL_SIGNING_KEY`, `NTFY_PROGRESS_TOPIC` (app repo).
