---
name: relay-review
argument-hint: "[branch-name or PR-number]"
description: Independent PR review after Codex dispatch. Re-scores the rubric and reviews against Done Criteria in a fresh context, free from planning bias. Returns LGTM or specific issues with file:line references.
context: fork
compatibility: context:fork requires Claude Code. Other agents should start a new session before reviewing. Requires gh CLI.
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-merge"
---

# Relay Review

Independent PR review against the Done Criteria contract and scoring rubric. Loops until convergence — the rubric anchors each iteration to prevent drift.

## Setup: Establish the anchor

1. Get the PR diff and Done Criteria (this runs in a fresh context — fetch everything needed):
```bash
PR_NUM=$(gh pr list --head <branch> --json number -q '.[0].number')
gh pr diff $PR_NUM > /tmp/pr-diff.txt
ISSUE_NUM=$(gh pr view $PR_NUM --json closingIssuesReferences -q '.[0].number')
# Fallback if closingIssuesReferences is empty:
# ISSUE_NUM=$(gh pr view $PR_NUM --json body -q '.body' | grep -oiE '(closes|fixes|resolves) #[0-9]+' | grep -oE '[0-9]+' | head -1)
gh issue view $ISSUE_NUM  # Done Criteria / Acceptance Criteria source
```

2. **Fix the anchor** — these do NOT change across rounds:
   - Done Criteria from the issue (the contract)
   - Rubric factors + targets from the Score Log (if relay-plan was used)
   - Original scope boundary ("do not change" areas)

## Review Loop

Repeat until all checks pass. Each round re-measures against the **original anchor**, not the previous round's state.

### Contract checks
3. Review the diff against Done Criteria (see `references/reviewer-prompt.md`):
   - **Faithfulness**: Each Done Criteria item implemented? Scope respected?
   - **Stubs/placeholders**: Any `return null`, empty bodies, TODO in production paths?
   - **Integration**: Does it break callers/consumers of changed code?
   - **Security**: Auth/token handling, input validation, injection risks?

4. **Rubric verification** (when Score Log present):
   - Re-run ALL automated checks independently — do not trust Codex's reported results
   - Re-score ALL evaluated factors with fresh eyes (1-10)
   - Any required factor below target → issue
   - Score divergence ≥2 points from Codex → flag for review

### Quality checks
5. Run `/review` — code quality, patterns, conventions, structural issues
6. Run `/simplify` on changed files — unnecessary complexity, dead code

### Drift check
7. Before re-dispatching, verify the fix request stays within the original scope:
   - Does the fix address an issue from steps 3-6, or is it scope creep?
   - Are previously passing rubric factors still passing? (no regressions)
   - Is the total diff growing without convergence? (sign of churn)

### Iterate or converge
8. All checks pass → exit loop, proceed to Verdict
9. Issues found → re-dispatch (see Re-dispatch below), re-fetch diff, **repeat from step 3**

**Safety cap: 20 rounds total.** This is a ceiling, not a target — most PRs should converge in 1-3 rounds. If hitting the cap, something is structurally wrong; escalate.

## Verdict + Audit Trail

10. All checks pass → write **LGTM PR comment**:
```bash
gh pr comment $PR_NUM --body "$(cat <<'EOF'
<!-- relay-review -->
## Relay Review
Verdict: LGTM
Contract: PASS — all Done Criteria verified
Quality: PASS — /review and /simplify clean
Rounds: <N>
Rubric scores (if applicable):
| Factor | Target | Codex | Claude | Status |
|--------|--------|-------|--------|--------|
| ...    | ...    | ...   | ...    | PASS   |
EOF
)"
```
<!-- NOTE: Verdict line format is parsed by relay and relay-merge gate checks via grep -oE 'Verdict: (LGTM|ESCALATED)'. Do not add markdown formatting. -->

11. Hit safety cap or stuck → escalate to user. Still write audit trail:
```bash
gh pr comment $PR_NUM --body "$(cat <<'EOF'
<!-- relay-review -->
## Relay Review
Verdict: ESCALATED — unresolved after <N> rounds
Issues: [list with file:line]
EOF
)"
```

## Re-dispatch (when issues found)

Targeted fix via relay-dispatch. Always include the anchor context:
```
Fix these issues in the PR: [specific issues with file:line].
Do not change anything else. Push to the same branch.

Original Done Criteria (for scope reference):
[paste Done Criteria from issue]

After fixing, re-run these checks and confirm they pass:
[paste automated check commands from the original rubric]
```

See `references/evaluate-criteria.md` for escalation policy (auto re-dispatch vs ask user).
