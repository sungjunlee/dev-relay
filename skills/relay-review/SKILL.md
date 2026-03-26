---
name: relay-review
description: Independent PR review after Codex dispatch. Reviews PR diff against Done Criteria contract in a fresh Agent context, free from planning bias. Use after relay-dispatch completes and a PR exists. Returns LGTM or specific issues with file:line references.
context: fork
metadata:
  related-skills: relay, relay-dispatch, relay-merge
---

# Relay Review

Independent PR review against the Done Criteria contract.

## Process

1. Get the PR diff:
```bash
PR_NUM=$(gh pr list --head <branch> --json number -q '.[0].number')
gh pr diff $PR_NUM > /tmp/pr-diff.txt
```

2. Review using the prompt template below. Paste in the Done Criteria and PR diff.

3. Reply with **LGTM** or **specific issues** with `file:line` references.

## Review Prompt

Use `references/reviewer-prompt.md` as the review template, or use this inline:

### Phase A: Faithfulness (contract check)
For each Done Criteria item, verify it is implemented:
- Missing requirement? (listed but not implemented)
- Scope creep? (not listed but added)
- Misinterpretation? (interpreted differently than intended)
- Boundary violation? (areas marked "do not change" were modified)

### Phase B: Quality
Check for issues Codex tends to miss:
- **Stubs/placeholders**: `return null`, empty bodies, TODO, mock data in production paths
- **Over-complexity**: can anything be simpler without losing functionality?
- **Convention violations**: naming, patterns, style inconsistent with existing codebase
- **Integration issues**: does it break callers/consumers of changed code?
- **Security**: auth/token handling, input validation, injection risks
- **Dead code**: unused imports, functions, variables

### Verdict

- **LGTM** — all Phase A items pass, no critical Phase B issues, no stubs remaining
- **Issues found** — list each issue with `file:line` reference

Do NOT flag stylistic nitpicks. Only flag issues a senior engineer would fix before merging.

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
- Judges only against the contract
- Codex already self-reviewed, so this catches only what Codex missed

## Evaluate Criteria

See `references/evaluate-criteria.md` for the full rationale and checklist.
