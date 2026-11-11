#!/usr/bin/env bash
# Fail fast, with the real reason, if the agent could not possibly run: missing/invalid key, unknown model,
# no credit, rate limit. Makes one 1-token request (a fraction of a cent) and reports what the API says.
# Env: ANTHROPIC_API_KEY, MODEL; optional ANTHROPIC_API_URL (tests), TRACE_DIR (default /tmp).
# On failure writes the reason to $TRACE_DIR/failure_reason.txt (read by the trace, the phone message and the dashboard).
set -uo pipefail
T="${TRACE_DIR:-/tmp}"
URL="${ANTHROPIC_API_URL:-https://api.anthropic.com/v1/messages}"

fail() {
  printf '%s' "$1" > "$T/failure_reason.txt"
  echo "::error title=Preflight failed::$1"
  exit 1
}

[ -n "${ANTHROPIC_API_KEY:-}" ] || fail "ANTHROPIC_API_KEY is not set in this repository's secrets. Add it under Settings, Secrets and variables, Actions."
[ -n "${MODEL:-}" ] || fail "No model is configured. Set agent.model in harness.config.yml."

body=$(jq -n --arg m "$MODEL" '{model:$m,max_tokens:1,messages:[{role:"user",content:"ping"}]}')
code=$(curl -sS -m 30 -o "$T/preflight.json" -w '%{http_code}' "$URL" \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d "$body") \
  || fail "Could not reach the Anthropic API (network error or timeout)."

if [ "$code" = "200" ]; then
  echo "Anthropic API check passed (model $MODEL)."
  exit 0
fi

msg=$(jq -r '.error.message // empty' "$T/preflight.json" 2>/dev/null | tr -d '\r\n' | cut -c1-200)
case "$code" in
  401) hint="The API key was rejected. Create a new key in the Anthropic console and update the ANTHROPIC_API_KEY secret." ;;
  403) hint="The key is not allowed to use this model or API." ;;
  404) hint="The model was not found. Check agent.model in harness.config.yml." ;;
  429) hint="Rate limited or out of quota. Check limits and usage in the Anthropic console." ;;
  400) hint="The request was rejected; this is often a billing problem such as a credit balance that is too low." ;;
  5*)  hint="The Anthropic API had a server error. Try again in a few minutes." ;;
  *)   hint="Unexpected response." ;;
esac
fail "Anthropic API check failed (HTTP $code): ${msg:-no message}. $hint"
