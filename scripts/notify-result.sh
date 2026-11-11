#!/usr/bin/env bash
# After a fix run: tell the owner how it went, using /tmp/trace.json written by write-trace.sh.
#   - PR opened     -> "needs you" topic: PR ready (high priority) + "progress" topic: Done (low)
#   - no files      -> "needs you": No changes made
#   - anything else -> "needs you": Run failed (urgent)
# Env: TOPIC_ACT, TOPIC_PRG (either may be empty), REPO, ISSUE, RUN_URL, ISSUE_URL, MODEL, AGENT_OUTCOME
# Best effort: a notification problem never fails the run.
set +e
here="$(cd "$(dirname "$0")" && pwd)"
send() { bash "$here/ntfy-send.sh" "$@" || echo "::warning::ntfy send failed"; }

project="${REPO#*/}"
T="${TRACE_DIR:-/tmp}"
trace="$T/trace.json"
get() { [ -f "$trace" ] && jq -r "$1" "$trace" 2>/dev/null; }

outcome=$(get '[.chain[] | select(.stage=="pull_request")][0].outcome // empty')
pr_url=$(get '[.chain[] | select(.stage=="pull_request")][0].pr_url // empty')
cost=$(get '[.chain[] | select(.stage=="agent")][0].cost_usd // empty')
turns=$(get '[.chain[] | select(.stage=="agent")][0].turns // empty')
reason=$(get '[.chain[] | select(.stage=="agent")][0].error // empty')
[ -z "$reason" ] && reason=$(head -c 300 "$T/failure_reason.txt" 2>/dev/null | tr -d '\r\n')
introduced=$(get '[.chain[] | select(.stage=="verification")][0].introduced_failures | join(", ")')
[ -z "$outcome" ] && outcome="agent_failed"

detail="${MODEL:-model unknown}"
[ -n "$cost" ] && detail="$detail · \$$(printf '%.2f' "$cost")"
[ -n "$turns" ] && detail="$detail · $turns turns"

view() { jq -nc --arg l "$1" --arg u "$2" '{action:"view",label:$l,url:$u}'; }

case "$outcome" in
  pr_opened)
    if [ -n "$introduced" ]; then checks="Checks: this change broke $introduced"; tag="warning"; else checks="Checks: no new failures"; tag="tada"; fi
    actions=$(jq -nc --argjson a "$(view 'View PR' "$pr_url")" --argjson b "$(view 'View run' "$RUN_URL")" '[$a,$b]')
    [ -n "$TOPIC_ACT" ] && send "$TOPIC_ACT" "[$project] #$ISSUE · PR ready" "$(printf '%s\n%s' "$detail" "$checks")" "$tag" 4 "$actions" "$pr_url"
    [ -n "$TOPIC_PRG" ] && send "$TOPIC_PRG" "[$project] #$ISSUE · Done" "$(printf '%s\n%s' "$detail" "$checks")" "white_check_mark" 2 "[]" "$pr_url"
    ;;
  no_change)
    actions=$(jq -nc --argjson a "$(view 'View issue' "$ISSUE_URL")" --argjson b "$(view 'View run' "$RUN_URL")" '[$a,$b]')
    [ -n "$TOPIC_ACT" ] && send "$TOPIC_ACT" "[$project] #$ISSUE · No changes made" "The agent finished without editing any files. The issue may need to be clearer." "warning" 3 "$actions" "$ISSUE_URL"
    ;;
  *)
    actions=$(jq -nc --argjson a "$(view 'View run' "$RUN_URL")" --argjson b "$(view 'View issue' "$ISSUE_URL")" '[$a,$b]')
    [ -n "$TOPIC_ACT" ] && send "$TOPIC_ACT" "[$project] #$ISSUE · Run failed" "${reason:-The fix run did not finish (agent: ${AGENT_OUTCOME:-unknown}). Open the run to see where it stopped.}" "x,rotating_light" 5 "$actions" "$RUN_URL"
    ;;
esac
exit 0
