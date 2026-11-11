# Plan: one-step install, in-app feedback section, before/after micro-releases

Status: proposal, written 11 November 2026. Nothing here is built. Facts marked **(verified)** come from official docs read for this plan; **(unverified)** items are assumptions that a spike must confirm before we build on them.

## 0. How I read the request

- **"Beta app user"** = a developer or team adopting this tool for their own app (a customer of the tool), not the end tester. Testers are the people who use the feedback section the tool adds. If you meant testers installing something, this plan changes.
- **"See the feature side by side before and after"** = for every merged change, a short clip (or screenshots) of just the affected screen, labeled Before and After, attached to that change. "Live" is covered by preview builds (Phase 1b); a recorded clip is the default.
- **Micro-release** = every merged agent change is its own release entry, finer than version 1.48 to 1.49. It has an id, a plain-language note, and its clip.

## 1. The target experience

```
DEVELOPER (once)                      TESTER                         OWNER (every change)
 install ──► PR adds a Feedback  ──►  types feedback in the app ──►  approve on phone
 (1 command / 1-2 clicks)  section        │                          │
                                          ▼                          ▼
                                   intake + triage ──► issue ──► agent builds ──► draft PR
                                                                          │
                                         before/after clip ◄── CI records both builds
                                                │
                                   merge ──► micro-release (note + clip) ──► dashboard, tester "What's new"
```

## 2. Part A: installation

### 2.1 What "one click" can honestly mean

| Tier | What the developer does | What it needs | Facts |
|---|---|---|---|
| 1. `init` command | Runs one command in their repo | The CLI, `doctor`, the SDK, a deployed Worker | Self-contained. One command, not one click |
| 2. Buttons | Clicks "Deploy to Cloudflare", then "Create GitHub App", then "Install" | Worker in its own public repo; an App manifest | Deploy button clones the repo into their account and provisions KV/D1/R2 etc. but repos must be **public and Workers-only** **(verified)**; whether it prompts for secret values is **not stated** (spike). A GitHub App can be created from a manifest with preset permissions and events **(verified)**; creating and installing on chosen repos in the same flow is **not stated**, so assume two clicks |
| 3. Hosted | Installs one GitHub App from a listing | A multi-tenant service: accounts, isolation, billing, support | True one click. Real operational and liability cost |

**Recommendation:** build Tier 1 now (it contains every piece Tier 2 reuses), add Tier 2 when a second outside developer exists, and defer Tier 3 until there are users beyond you. This matches the earlier decision: self-hosted first, hosted later.

### 2.2 What an install does

1. Detects the stack and writes the workflow callers and `harness.config.yml`.
2. Creates the labels; offers branch protection (guardrails are only advisory without it).
3. Provisions or connects the Worker; stores secrets with the self-verifying pattern (no clipboard, no pasting, ends with a pass/fail line).
4. **Adds the feedback section to the app** (2.3).
5. Runs `doctor`, then a real end-to-end self-test: send a test message, see the issue appear, close it.

### 2.3 The feedback section (React Native first)

**Package** `@feedback-to-pr/react-native`: a `FeedbackScreen`, a `useFeedback()` hook and a ready-made Settings row.

- Fields: message, optional screenshot; **automatic context**: app version, platform, OS, device, locale, current screen, install id.
- States: sending, sent, error, and an **offline queue** so a message is never lost.
- Accessibility labels, large-text support, light/dark, strings overridable for i18n, theme taken from the host app's tokens.
- Beta gating: a signed reporter token supplied by the app, or an install id on an allowlist. Raw text never goes into a public issue.
- Entry points: Settings row (default), shake, or floating button.

**How the section gets into the app:** navigation and theming differ per app, so a fixed codemod will break. The installer instead opens an issue **"Add a Feedback section"** with a precise spec and the `ai-fix` label, and the harness's own fix agent adapts the SDK to that app's navigation, tokens and conventions (it already reads `CLAUDE.md`). The framework installs itself with its own pipeline, and the owner reviews it like any PR. A deterministic template is the fallback for repos where the agent fails.

**Other stacks:** a web snippet and the plain REST API (`POST /v1/feedback`) first; native iOS and Android later.

### 2.4 Server prerequisites (not built)

OpenAPI-specified `POST /v1/feedback`, per-reporter rate limits and idempotency, triage that rewrites feedback into an anonymous scoped issue with a **swappable model** (`llm:` config), duplicate detection, and storage of raw text outside GitHub.

## 3. Part B: before/after demo

### 3.1 The product

For each pull request: a clip of at most about 15 seconds, the changed screen only, **Before** left and **After** right, plus a poster image. Fallbacks, in order: side-by-side screenshots; then "no visual change" with the diff summary and test evidence (logic, data and test-only changes).

### 3.2 The pipeline

```
 main ──► baseline build (cached per main commit)  ─┐
                                                    ├► emulator ► same scripted flow ► 2 recordings ► stitch ► host ► link
 PR   ──► PR build ─────────────────────────────────┘
```

1. **Baseline** is built when `main` changes and cached, so a PR only pays for one build.
2. **The flow** is a short script that navigates to the changed screen and exercises it. The fix agent writes it as part of the PR (`.feedback/demo/<issue>.yaml`), using `testID`s or deep links. The harness runs it on the **baseline first**; if navigation fails there, the demo is declared "not available" instead of showing a broken clip.
3. **Record** both runs on the same emulator profile, **stitch** with ffmpeg (labels Before/After), and produce an mp4 plus a poster.
4. **Publish**: link in the PR body, on the dashboard card, and in the micro-release.

### 3.3 Platform reality

| Question | Finding |
|---|---|
| Record a flow | Maestro: `maestro record --local flow.yaml` **(verified)**. `testID` maps to Maestro `id` **(verified)** |
| Run Maestro in GitHub Actions | The official action targets Maestro Cloud, which needs a paid plan **(verified)**. Running the open-source CLI on a plain runner is **(unverified)** |
| Android emulator on Linux runners | Hardware acceleration (KVM) on `ubuntu-latest` **(unverified)**; the docs page for it could not be read |
| iOS simulator | Needs macOS runners, about 10 times the per-minute price of Linux ($0.062 vs $0.006) **(verified)**. Recommend: Android first, iPhone demos on demand |
| Attach a video to a PR comment | The comments API accepts text only **(verified)**; attachments are UI-only |
| Host a clip | GitHub release assets can be uploaded by API **(verified)**; visibility for private repos is **not stated**. Alternatives: Cloudflare R2 served through the Worker (access control we own), or workflow artifacts (retention unknown) |

**MediSync specifics:** no e2e tooling today. It has about 120 `testID`s, a custom `rx101://` deep link scheme, and a Component Showcase screen that shows components in isolation, which makes deterministic demos feasible. It is a health app: **demos must run on seeded fixture data, never real data**, which needs an app-side "demo mode" the installer asks for.

### 3.4 Cost and time (estimates, unverified)

An Android build plus emulator run is likely 10 to 25 minutes of Linux runner time per PR, a few cents. Spike to confirm. The same build can double as the phone preview build (Phase 1b).

## 4. Part C: micro-release changelog

- **Id:** `YYYY.MM.DD-n` (date plus sequence), separate from the app's own version. MediSync's `version.properties` is not touched.
- **Entry:** plain-language title and note, the before/after clip and poster, the issue, how many testers asked, risk label, preview-build id, merged commit and date. Owner-only fields (model, cost) are stripped for testers.
- **Source of the note:** a "User-facing note" section the agent writes in the PR body; you edit it during review, because you review the PR anyway. A wrong summary is caught at that gate.
- **Storage:** a GitHub Release per micro-release (tag `micro/<id>`, notes plus hidden JSON, clip as an asset or an R2 link). GitHub stays the database.
- **Surfaces:** dashboard "Changelog" tab with a side-by-side player; the PR; an in-app **What's new** for beta testers via a token-gated `GET /v1/changes`; a "shipped" push to the testers who asked.

## 5. Build order

| # | Milestone | Done when |
|---|---|---|
| M1 | Switch the dashboard on; diagnose the failed run and print failure reasons; `doctor` v1 | Dashboard shows real data; every failure names its cause |
| M2 | Intake: `POST /v1/feedback`, triage, beta gating, swappable model | A curl call produces an anonymous triaged issue; raw text is not on GitHub |
| M3 | RN SDK + `init` | On a fresh sample app, one command opens a PR; merged, the Feedback screen works and a test message becomes an issue |
| **S** | **Spike (1 to 2 days, before M4)**: emulator + Maestro CLI on a plain runner; hosting choice | CI makes a 10 s side-by-side mp4 from two commits with no human step |
| M4 | Demo pipeline: baseline cache, agent-written flow, publish | A real PR shows its clip on the PR and the dashboard |
| M5 | Micro-release changelog + in-app What's new | Merge creates the release; testers see it in the app |
| M6 | Tier 2 install buttons; iPhone demos | A second developer installs without help |

M1 and M2 are prerequisites for everything. The spike can run any time and de-risks M4, so I would run it early.

## 6. Risks and open questions

| Risk | Mitigation |
|---|---|
| Emulator or Maestro does not run on plain runners | Spike first. Fallbacks: screenshots from a headless render of the Component Showcase; or a paid cloud device service |
| Agent-written flows break or lie | Always run on baseline first; mark "demo unavailable" rather than show a wrong clip |
| Recordings expose real data | Fixture-only demo mode; installer refuses to enable demos without it |
| Clip hosting in private repos | Decide after the spike; R2 behind the Worker is the safe default |
| Deploy button limits (public, Workers-only repo) | Put the Worker in its own public repo before Tier 2 |
| Install into very different apps | Agent-adapted section with a deterministic fallback; start with React Native only |

**Decisions I need from you (defaults let me continue if you are away):**
1. Is "beta app user" a developer adopting the tool (default) or an end tester?
2. Android-only demos first (default yes)?
3. Clip hosting: try GitHub release assets first, R2 if private access fails (default)?
4. Feedback entry point: Settings row (default)?
5. Test the installer on a fresh sample app (default) or on MediSync?

## 7. Not in scope yet

Hosted multi-tenant service, billing, native iOS/Android SDKs, a public changelog page, auto-approval, video of backend-only changes.
