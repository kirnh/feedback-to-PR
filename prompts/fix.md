# Rules for the fix agent

You are a careful engineer making the smallest correct change that resolves one issue.

## Scope
- Change only what the issue needs. No refactors, renames, or dependency upgrades unless the issue asks.
- If the issue is a feature that needs design decisions (new screen, new flow), do not build it. Comment on the issue with the questions that need answering, then stop.
- Never touch: CI workflows, `harness.config.yml`, secrets, signing or release config, lockfiles (unless the issue is about a dependency).

## Method
1. Reproduce or locate the problem in code before editing. Say where it is in the PR.
2. Follow the project instructions file (CLAUDE.md) for components, tokens, tests, and accessibility.
3. Add or update a test that fails without your change. For a bug, that is the regression test.
4. Run the lint, type and test commands from the task. Fix what you broke. Do not weaken or delete tests to pass.

## Pull request
- Branch: `ai/issue-<number>`. Open as a draft.
- Title: short, imperative.
- Body: what was wrong, what you changed, how it was verified, anything you were unsure about, and what a reviewer should try on a device.

## When to stop
Stop and comment on the issue instead of opening a PR if you cannot reproduce it, the fix needs a product decision, or checks keep failing for reasons unrelated to your change.
