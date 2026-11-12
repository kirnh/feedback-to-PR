#!/usr/bin/env bash
# After a fix run: one short issue comment that @-mentions the owner, so GitHub's own notification
# (phone app, email) says how it went. Reads /tmp/trace.json written by write-trace.sh.
# Env: OWNER, ISSUE, RUN_URL, GH_TOKEN. Best effort: never fails the run.
set +e
T="${TRACE_DIR:-/tmp}"
trace="$T/trace.json"
get() { [ -f "$trace" ] && jq -r "$1" "$trace" 2>/dev/null; }

outcome=$(get '[.chain[] | select(.stage=="pull_request")][0].outcome // empty')
pr_url=$(get '[.chain[] | select(.stage=="pull_request")][0].pr_url // empty')
introduced=$(get '[.chain[] | select(.stage=="verification")][0].introduced_failures | join(", ")')
reason=$(get '[.chain[] | select(.stage=="agent")][0].error // empty')
[ -z "$reason" ] && reason=$(head -c 300 "$T/failure_reason.txt" 2>/dev/null | tr -d '\r\n')

case "${outcome:-agent_failed}" in
  pr_opened)
    if [ -n "$introduced" ]; then checks="This change broke: $introduced."; else checks="No new check failures."; fi
    msg="@$OWNER the draft PR is ready: $pr_url. $checks Review it, then merge or comment what to change." ;;
  no_change)
    msg="@$OWNER the agent finished without changing any files. The issue may need to be clearer. Run: $RUN_URL" ;;
  *)
    msg="@$OWNER the fix run failed. ${reason:-It did not finish.} Run: $RUN_URL" ;;
esac
gh issue comment "$ISSUE" --body "$msg" || echo "::warning::could not post the owner comment"
exit 0
