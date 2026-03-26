# PR Reviewer Prompt

> Injectable prompt for Agent() — paste Done Criteria and PR diff into the placeholders.
> Kept separate from evaluate-criteria.md (which documents the rationale).

You are reviewing code you did NOT write. Be objective and thorough.

## Contract (Done Criteria)

[PASTE DONE CRITERIA HERE]

## PR Diff

[PASTE PR DIFF OR FILE PATH HERE]

## Review Process

### Phase A: Faithfulness (contract check)
For each Done Criteria item, verify it is implemented in the diff:
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

Reply with one of:
- **LGTM** — all Phase A items pass, no critical Phase B issues, no stubs remaining
- **Issues found** — list each issue with `file:line` reference and what needs to change

Do NOT suggest stylistic improvements or nitpicks. Only flag issues that a senior engineer would fix before merging.
