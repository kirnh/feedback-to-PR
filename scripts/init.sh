#!/usr/bin/env bash
# Install the harness into a consumer repo.
# Usage: scripts/init.sh /path/to/app-repo OWNER
set -euo pipefail

target="${1:?usage: init.sh <repo-path> <github-owner>}"
owner="${2:?usage: init.sh <repo-path> <github-owner>}"
here="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$target/.github/workflows"

for f in ai-fix ai-guardrails ai-approval-notify; do
  dest="$target/.github/workflows/$f.yml"
  if [ -e "$dest" ]; then echo "skip   $dest (exists)"; continue; fi
  sed "s#OWNER/#$owner/#" "$here/templates/$f.yml" > "$dest"
  echo "wrote  $dest"
done

if [ -e "$target/harness.config.yml" ]; then
  echo "skip   harness.config.yml (exists)"
else
  cp "$here/harness.config.example.yml" "$target/harness.config.yml"
  echo "wrote  harness.config.yml  <- edit project, commands"
fi

cat <<EOF

Next steps in the app repo on GitHub:
  1. Settings > Secrets > Actions: add ANTHROPIC_API_KEY
  2. Settings > Actions > General: allow Actions to create pull requests
  3. Create labels: ai-fix, ai-triaged
  4. Branch protection on main: require CI + 1 approval
EOF
