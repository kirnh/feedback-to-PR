#!/usr/bin/env bash
# Send one ntfy notification. Plain text only (the iPhone app shows markdown as raw symbols).
# Usage: ntfy-send.sh <topic> <title> <message> <tags-csv> <priority 1-5> [actions-json-array] [click-url]
# Env:   NTFY_SERVER   default https://ntfy.sh
#        NTFY_DRY_RUN  if set, print the JSON payload instead of sending
# Buttons: only "view" and "http" work on iPhone ("copy" does not). ntfy allows at most 3.
set -euo pipefail

topic="${1:?topic}"; title="${2:?title}"; message="${3:?message}"
tags="${4:-}"; prio="${5:-3}"; actions="${6:-[]}"; click="${7:-}"

payload=$(jq -nc \
  --arg topic "$topic" --arg title "$title" --arg message "$message" --arg tags "$tags" \
  --argjson prio "$prio" --argjson actions "$actions" --arg click "$click" '
  {topic:$topic, title:$title, message:$message, priority:$prio,
   tags:($tags | split(",") | map(select(length>0))), actions:$actions}
  + (if $click == "" then {} else {click:$click} end)')

if [ -n "${NTFY_DRY_RUN:-}" ]; then echo "$payload"; exit 0; fi
curl -sS -f -m 15 -X POST -H "Content-Type: application/json" -d "$payload" "${NTFY_SERVER:-https://ntfy.sh}" > /dev/null
