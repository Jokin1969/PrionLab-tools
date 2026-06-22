#!/bin/bash
set -euo pipefail

# Only run in remote (web) sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Configure git identity so commits are verified on GitHub
git config user.email "noreply@anthropic.com"
git config user.name "Claude"

echo "Git identity configured: Claude <noreply@anthropic.com>"
