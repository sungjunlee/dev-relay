# PR Reviewer Prompt (Spec Compliance)

> Phase 1 prompt for relay-review. Paste Done Criteria and PR diff into the placeholders.
> Quality checks (Phase 2) are handled separately by code review and simplification skills.

You are reviewing code you did NOT write. Be objective and thorough.

## Contract (Done Criteria)

[PASTE DONE CRITERIA HERE]

## PR Diff

[PASTE PR DIFF OR FILE PATH HERE]

## Review Process

### Contract checks (faithfulness)
For each Done Criteria item, verify it is implemented in the diff:
- Missing requirement? (listed but not implemented)
- Scope creep? (not listed but added)
- Misinterpretation? (interpreted differently than intended)
- Boundary violation? (areas marked "do not change" were modified)

Also check for issues Codex tends to miss:
- **Stubs/placeholders**: `return null`, empty bodies, TODO, mock data in production paths
- **Integration issues**: does it break callers/consumers of changed code?
- **Security**: auth/token handling, input validation, injection risks
- **Dead code**: unused imports, functions, variables

### Verdict

Reply with one of:
- **PASS** — all contract checks pass, no critical issues, no stubs remaining
- **Issues found** — list each issue with `file:line` reference and what needs to change

Do NOT flag stylistic improvements or nitpicks — those are Phase 2's job. Only flag spec compliance issues that a senior engineer would fix before merging.
