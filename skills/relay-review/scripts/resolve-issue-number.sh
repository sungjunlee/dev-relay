#!/usr/bin/env bash
# Resolve the GitHub issue number associated with a PR for legacy manual review.
#
# `review-runner/context.js` is the canonical resolver. This helper mirrors its
# conservative fallback order where manual shell review still uses it:
#   1. PR body explicit closing keywords: Fix/Fixes, Close/Closes, Resolve/Resolves
#   2. Branch name — `issue-N`
#   3. A single PR `closingIssuesReferences` API entry
#
# Manifest issue anchors and file-backed Done Criteria anchors are runner-only;
# pass those to review-runner instead of this helper.
#
# Usage:  resolve-issue-number.sh <PR_NUMBER> [<BRANCH>]
# Stdout: the resolved issue number
# Exit:   0 on success, 1 if all fallbacks fail (with stderr error)

set -euo pipefail

PR_NUM="${1:?usage: resolve-issue-number.sh <PR_NUMBER> [<BRANCH>]}"
BRANCH="${2:-}"

PR_JSON=$(gh pr view "$PR_NUM" --json closingIssuesReferences,body,headRefName 2>/dev/null || true)

set +e
ISSUE_NUM=$(PR_JSON="$PR_JSON" BRANCH="$BRANCH" PR_NUM="$PR_NUM" node <<'NODE'
const parsed = process.env.PR_JSON ? JSON.parse(process.env.PR_JSON) : {};
const unique = (values) => [...new Set(values.map(Number).filter((number) => Number.isInteger(number) && number > 0))];

const bodyMatches = String(parsed.body || "").matchAll(/\b(?:close|closes|fix|fixes|resolve|resolves)\s+#(\d+)\b/gi);
const bodyNumbers = unique([...bodyMatches].map((match) => match[1]));
if (bodyNumbers.length > 1) {
  console.error(`ERROR: Ambiguous PR body closing keywords reference multiple issues: ${bodyNumbers.map((number) => `#${number}`).join(", ")}.`);
  process.exit(2);
}
if (bodyNumbers.length === 1) {
  console.log(bodyNumbers[0]);
  process.exit(0);
}

const branch = process.env.BRANCH || parsed.headRefName || "";
const branchMatch = String(branch).match(/issue-(\d+)/i);
if (branchMatch) {
  console.log(branchMatch[1]);
  process.exit(0);
}

const closingNumbers = unique((Array.isArray(parsed.closingIssuesReferences) ? parsed.closingIssuesReferences : []).map((reference) => reference && reference.number));
if (closingNumbers.length > 1) {
  console.error(`ERROR: Ambiguous GitHub closing issue references for PR #${process.env.PR_NUM}: ${closingNumbers.map((number) => `#${number}`).join(", ")}. Provide an explicit Done Criteria anchor.`);
  process.exit(2);
}
if (closingNumbers.length === 1) {
  console.log(closingNumbers[0]);
}
NODE
)
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  exit "$STATUS"
fi

if [ -z "$ISSUE_NUM" ]; then
  echo "ERROR: Cannot determine issue number for PR #$PR_NUM. Provide it manually." >&2
  exit 1
fi

echo "$ISSUE_NUM"
