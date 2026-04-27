#!/usr/bin/env bash
# Resolve the GitHub issue number associated with a PR.
#
# Tries three fallbacks in order, prints the first match to stdout:
#   1. PR's `closingIssuesReferences` API field (gh-linked issue)
#   2. PR body grep for `(closes|fixes|resolves|refs|related to) #N`
#   3. Branch name — `issue-N` first, then any trailing number
#
# Usage:  resolve-issue-number.sh <PR_NUMBER> [<BRANCH>]
# Stdout: the resolved issue number
# Exit:   0 on success, 1 if all fallbacks fail (with stderr error)

set -euo pipefail

PR_NUM="${1:?usage: resolve-issue-number.sh <PR_NUMBER> [<BRANCH>]}"
BRANCH="${2:-}"

# Method 1: PR-linked issue via gh API
ISSUE_NUM=$(gh pr view "$PR_NUM" --json closingIssuesReferences \
  -q '.closingIssuesReferences[0].number' 2>/dev/null || true)
[ "$ISSUE_NUM" = "null" ] && ISSUE_NUM=""

# Method 2: PR body keyword grep
if [ -z "$ISSUE_NUM" ]; then
  ISSUE_NUM=$(gh pr view "$PR_NUM" --json body -q '.body' 2>/dev/null \
    | grep -oiE '(closes|fixes|resolves|refs|related to) #[0-9]+' \
    | grep -oE '[0-9]+' \
    | head -1 || true)
fi

# Method 3: branch name (issue-N preferred, else trailing digits)
if [ -z "$ISSUE_NUM" ]; then
  if [ -z "$BRANCH" ]; then
    BRANCH=$(gh pr view "$PR_NUM" --json headRefName -q '.headRefName' 2>/dev/null || true)
  fi
  ISSUE_NUM=$(echo "$BRANCH" | grep -oE 'issue-[0-9]+' | grep -oE '[0-9]+' || true)
  if [ -z "$ISSUE_NUM" ]; then
    ISSUE_NUM=$(echo "$BRANCH" | grep -oE '[0-9]+' | tail -1 || true)
  fi
fi

if [ -z "$ISSUE_NUM" ]; then
  echo "ERROR: Cannot determine issue number for PR #$PR_NUM. Provide it manually." >&2
  exit 1
fi

echo "$ISSUE_NUM"
