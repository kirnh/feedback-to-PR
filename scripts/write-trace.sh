#!/usr/bin/env bash
# Assemble the judgement-chain trace for one fix run.
# Writes /tmp/trace.json (machine-readable) and /tmp/trace.md (for the issue comment).
# Safe to run when earlier steps were skipped or failed: missing data becomes null.
#
# Chain, in order:  triage (if present) -> approval -> agent -> verification -> pull request
set +e

num() { [ -f "$1" ] && cat "$1" || echo null; }
hash() { [ -f "$1" ] && sha256sum "$1" | cut -c1-12 || echo null; }

# --- agent result (claude-code writes an execution file; other runners may not) -------
agent='{}'
if [ -n "$EXECUTION_FILE" ] && [ -f "$EXECUTION_FILE" ]; then
  agent=$(jq -c '[.[] | select(.type=="result")] | last // {}' "$EXECUTION_FILE" 2>/dev/null || echo '{}')
fi
[ -z "$agent" ] && agent='{}'

# --- triage stage, if the intake service embedded one in the issue body ----------------
triage=null
if [ -f /tmp/issue.json ]; then
  raw=$(jq -r .body /tmp/issue.json 2>/dev/null | sed -n 's/.*<!-- f2pr-trace:triage \(.*\) -->.*/\1/p' | head -1)
  if [ -n "$raw" ] && echo "$raw" | jq -e . >/dev/null 2>&1; then triage="$raw"; fi
fi

# --- verification: baseline vs after, per check -----------------------------------------
checks='[]'
for n in Lint Types Tests; do
  b=$(num "/tmp/checks/baseline.$n.code"); a=$(num "/tmp/checks/after.$n.code")
  checks=$(echo "$checks" | jq -c --arg n "$n" --argjson b "$b" --argjson a "$a" \
    '. + [{check:$n, baseline_exit:$b, after_exit:$a, introduced: (($b==0) and ($a!=null) and ($a!=0))}]')
done

# --- outcome -------------------------------------------------------------------------------
if [ -s /tmp/pr_url.txt ]; then outcome=pr_opened
elif [ "$DIFF_CHANGED" = "false" ]; then outcome=no_change
elif [ "$AGENT_OUTCOME" != "success" ]; then outcome=agent_failed
else outcome=incomplete; fi

jq -n \
  --arg run_url "$RUN_URL" --arg repo "$REPO" --arg base_sha "$BASE_SHA" \
  --arg harness_ref "$HARNESS_REF" --arg harness_sha "$HARNESS_SHA" \
  --arg started "$STARTED_AT" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson issue "${ISSUE:-0}" --arg approved_by "$APPROVED_BY" \
  --arg runner "$RUNNER" --arg model_requested "$MODEL" --arg agent_outcome "$AGENT_OUTCOME" \
  --arg config_hash "$(hash harness.config.yml)" --arg fix_prompt_hash "$(hash .harness/prompts/fix.md)" \
  --arg task_hash "$(hash /tmp/task.md)" \
  --argjson triage "$triage" --argjson agent "$agent" --argjson checks "$checks" \
  --arg outcome "$outcome" --arg pr_url "$(cat /tmp/pr_url.txt 2>/dev/null)" --arg commit "$(cat /tmp/commit_sha.txt 2>/dev/null)" \
  --rawfile changed /tmp/changed.txt \
  '{
    schema: "feedback-to-pr.trace/1",
    run: {url:$run_url, repo:$repo, base_sha:$base_sha, started_at:$started, finished_at:$finished},
    harness: {ref:$harness_ref, sha:$harness_sha, config_hash:$config_hash, fix_prompt_hash:$fix_prompt_hash},
    chain: [
      (if $triage == null then empty else {stage:"triage", detail:$triage} end),
      {stage:"approval", issue:$issue, approved_by:$approved_by, how:"ai-fix label added by a person"},
      {stage:"agent", runner:$runner, model_requested:$model_requested,
       models_used: (($agent.modelUsage // {}) | keys),
       outcome:$agent_outcome, turns:($agent.num_turns // null), cost_usd:($agent.total_cost_usd // null),
       duration_ms:($agent.duration_ms // null), task_hash:$task_hash},
      {stage:"verification", checks:$checks, introduced_failures:[$checks[] | select(.introduced) | .check]},
      {stage:"pull_request", outcome:$outcome, pr_url:(if $pr_url=="" then null else $pr_url end),
       commit:(if $commit=="" then null else $commit end), files_changed:($changed | split("\n") | map(select(length>0)))}
    ]
  }' > /tmp/trace.json

# --- readable version ----------------------------------------------------------------------
{
  echo "### Judgement trace for this run"
  echo
  jq -r '
    .chain as $c |
    ($c[] | select(.stage=="approval")) as $ap |
    ($c[] | select(.stage=="agent")) as $ag |
    ($c[] | select(.stage=="verification")) as $v |
    ($c[] | select(.stage=="pull_request")) as $pr |
    "| Step | Decision |",
    "|---|---|",
    (if ($c[0].stage=="triage") then "| Triage | \($c[0].detail | tostring) |" else empty end),
    "| Approval | #\($ap.issue) approved by @\($ap.approved_by) (label `ai-fix`) |",
    "| Agent | runner `\($ag.runner)`, model `\(($ag.models_used | join(",")) | if .=="" then $ag.model_requested else . end)`, outcome `\($ag.outcome)`, \($ag.turns // "?") turns, cost $\($ag.cost_usd // "n/a") |",
    "| Verification | " + ($v.checks | map("\(.check): \(if .baseline_exit==0 then "pass" else "fail" end) → \(if .after_exit==0 then "pass" else (if .after_exit==null then "n/a" else "fail" end) end)") | join("; ")) + " · introduced: \(if ($v.introduced_failures|length)==0 then "none" else ($v.introduced_failures|join(", ")) end) |",
    "| Result | `\($pr.outcome)`\(if $pr.pr_url then " → \($pr.pr_url)" else "" end) · \($pr.files_changed|length) file(s) |"
  ' /tmp/trace.json
  echo
  echo "Run: $RUN_URL · harness \`$HARNESS_REF@${HARNESS_SHA:0:8}\` · config \`$(hash harness.config.yml)\` · full JSON is attached to the run as the \`trace\` artifact."
} > /tmp/trace.md
exit 0
