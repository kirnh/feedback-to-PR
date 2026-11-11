#!/usr/bin/env bash
# Run the three configured checks and record results.
# Usage: run-checks.sh <label>        (label: baseline | after)
# Env:   LINT_CMD, TYPES_CMD, TEST_CMD
# Output: /tmp/checks/<label>.<Name>.code (exit code) and .log (combined output)
set +e
label="${1:?label required}"
mkdir -p /tmp/checks
for pair in "Lint|$LINT_CMD" "Types|$TYPES_CMD" "Tests|$TEST_CMD"; do
  name="${pair%%|*}"
  cmd="${pair#*|}"
  bash -c "$cmd" > "/tmp/checks/$label.$name.log" 2>&1
  echo $? > "/tmp/checks/$label.$name.code"
done
exit 0
