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

2. Review using `references/reviewer-prompt.md` — paste in the Done Criteria and PR diff. Launch as a fresh Agent.

3. Reply with **LGTM** or **specific issues** with `file:line` references.

## Rubric-Based Review

When the PR includes a Score Log (from relay-plan):

1. Read Codex's self-reported scores from PR description
2. **Re-run automated checks** that don't require a running server (tests, linting)
3. **Re-evaluate scored factors** with fresh eyes — score each 1-10
4. Run `/simplify` and `/review` skills for additional quality checks
5. If Claude's scores differ significantly from Codex's → flag specific factors in re-dispatch

## Re-dispatch (if issues found)

Targeted fix via relay-dispatch:
```bash
./scripts/dispatch.js . -b <same-branch> \
  -p "Fix these issues in the PR: [specific issues with file:line].
      Do not change anything else. Push to the same branch."
```

Then re-review. **Max 2 rounds** — after that, escalate to manual review.

## Why Fresh Context

- No planning bias ("there was probably a reason for this")
- Judges only against the contract + rubric
- Codex already self-scored, so this catches blind spots

## Review Criteria

See `references/reviewer-prompt.md` for the complete review prompt template.
See `references/evaluate-criteria.md` for the rationale behind Phase A (faithfulness) and Phase B (quality).
