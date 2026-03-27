---
name: relay-review
description: Independent PR review after Codex dispatch. Re-scores the rubric and reviews against Done Criteria in a fresh context, free from planning bias. Returns LGTM or specific issues with file:line references.
context: fork
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-merge"
  compatibility: "context:fork requires Claude Code. Other agents: start a new session before reviewing."
---

# Relay Review

Independent PR review against the Done Criteria contract and scoring rubric.

## Process

1. Get the PR diff:
```bash
PR_NUM=$(gh pr list --head <branch> --json number -q '.[0].number')
gh pr diff $PR_NUM > /tmp/pr-diff.txt
```

2. Review using `references/reviewer-prompt.md` — paste in the Done Criteria and PR diff.

3. Reply with **LGTM** or **specific issues** with `file:line` references.

## Rubric-Based Review

When the PR includes a Score Log (from relay-plan):

1. Read Codex's self-reported scores from PR description
2. **Re-run automated checks** that don't require a running server (tests, linting)
3. **Re-evaluate scored factors** with fresh eyes — score each 1-10
4. Run `/simplify` and `/review` skills for additional quality checks
5. If Claude's scores differ significantly from Codex's → flag specific factors in re-dispatch

## Re-dispatch (if issues found)

Targeted fix via relay-dispatch. **Include automated checks so Codex re-verifies after fixing:**

```
Fix these issues in the PR: [specific issues with file:line].
Do not change anything else. Push to the same branch.

After fixing, re-run these checks and confirm they pass:
[paste automated check commands from the original rubric]
```

**Max 2 re-dispatch rounds.** After that, escalate: show the user the PR URL, list unresolved issues, and let them decide (merge with caveats, fix manually, or discard).

## Review Criteria

See `references/reviewer-prompt.md` for the complete review prompt.
See `references/evaluate-criteria.md` for escalation policy (auto-fix vs ask-user).
