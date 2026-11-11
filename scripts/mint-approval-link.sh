#!/usr/bin/env bash
# Mint a signed, expiring, single-use approval token for the Worker's /v1/approve endpoint.
# Usage: mint-approval-link.sh <owner/repo> <issue-number> <approve|reject> [ttl-seconds]
# Env:   SIGNING_KEY   (the same HMAC key the Worker holds)
# Prints the token only. Must stay byte-compatible with server/src/token.ts (see its tests).
set -euo pipefail

: "${SIGNING_KEY:?SIGNING_KEY is required}"
repo="${1:?repo}"; issue="${2:?issue}"; action="${3:?approve|reject}"; ttl="${4:-86400}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

exp=$(( $(date +%s) + ttl ))
nonce=$(openssl rand -hex 12)
payload=$(jq -cn --arg r "$repo" --argjson i "$issue" --arg a "$action" --argjson e "$exp" --arg n "$nonce" \
  '{r:$r,i:$i,a:$a,e:$e,n:$n}')
p=$(printf '%s' "$payload" | b64url)
sig=$(printf '%s' "$p" | openssl dgst -sha256 -hmac "$SIGNING_KEY" -binary | b64url)
printf '%s.%s' "$p" "$sig"
