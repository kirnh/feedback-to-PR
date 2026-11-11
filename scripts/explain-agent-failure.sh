#!/usr/bin/env bash
# When the agent step fails, read the agent's own log and record WHY in $TRACE_DIR/failure_reason.txt.
# The action hides the error text in the job log; the execution file has it.
# Env: EXECUTION_FILE (may be empty), TRACE_DIR (default /tmp). Never fails the job.
set +e
T="${TRACE_DIR:-/tmp}"

# A reason recorded earlier (the preflight) is more specific; keep it.
if [ -s "$T/failure_reason.txt" ]; then exit 0; fi

reason=""
if [ -n "${EXECUTION_FILE:-}" ] && [ -f "$EXECUTION_FILE" ]; then
  reason=$(jq -r '
    ([.[]? | select(.type=="result")] | last // {}) as $r
    | if ($r | length) == 0 then empty
      else "The agent stopped with an error (" + ($r.subtype // "unknown") + ")"
           + (if ($r.result // "") != "" then ": " + $r.result else ": no message was given. It ran for " + (($r.duration_ms // 0)|tostring) + " ms with " + (($r.num_turns // 0)|tostring) + " turn(s) and used " + (if ($r.modelUsage // {}) == {} then "no model" else "a model" end) + ", so the request was probably rejected before it started (key, billing or model access)." end)
      end' "$EXECUTION_FILE" 2>/dev/null | tr -d '\r\n' | cut -c1-300)
fi
[ -z "$reason" ] && reason="The agent step failed before writing a log. Open the step output for details."

printf '%s' "$reason" > "$T/failure_reason.txt"
echo "$reason"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '### Why the agent failed\n\n%s\n' "$reason" >> "$GITHUB_STEP_SUMMARY"
exit 0
