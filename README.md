# feedback-to-PR

A beta tester types a note in the app. An AI turns it into a clean, anonymous GitHub issue. You approve it on your phone. An AI agent drafts the change as a pull request. You review it and merge. Model-agnostic and portable: one engine plus a small config per app repo.

```
app feedback box ──> Worker (triage AI) ──> GitHub issue [ai-triaged]
                                                  │  you add label ai-fix  (approval 1)
                                                  ▼
                                   AI agent in GitHub Actions ──> draft PR
                                                  │  you review and merge  (approval 2)
```

GitHub is the whole interface: issues, labels, pull requests and GitHub's own phone notifications. The only server is one small Cloudflare Worker that receives feedback from the app (an app cannot hold a GitHub token).

## Docs
- [Status](docs/STATUS.md): what works, what is proven, what is next
- [Setup](docs/SETUP.md): install into an app, set the keys
- [Architecture](docs/ARCHITECTURE.md): components, flow, security model
- [Keys](docs/SECRETS.md): every key, what it is for, where it is used (generated from `secrets.manifest.json`)
- [Intake API](spec/openapi.yaml): what the app sends

## Commands
```
node scripts/secrets.mjs list | setup | set <KEY>     every key, in one place (GitHub secrets)
node scripts/doctor.mjs --repo OWNER/APP --worker URL [--remote]   check every link, print the fix
node scripts/send-test-feedback.mjs                    send one test message through the whole intake
cd server && npm test                                  Worker, keys tool and doctor tests
```

## Layout
```
.github/workflows/   fix-issue (reusable), guardrails, doctor, deploy-worker
templates/           small caller workflows copied into each app repo (scripts/init.sh)
scripts/             keys tool, doctor, trace, checks, agent preflight
server/              the Worker: POST /v1/feedback, GET /v1/feedback/{id}, GET /v1/health
prompts/fix.md       the agent's rules
```
