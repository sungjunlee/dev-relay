# Prompt Template (Base)

> Simplified version. For rubric-enhanced prompts with automated checks and scored factors, use relay-plan instead.

```markdown
[What to implement]

## Context
- Relevant files: [entry points, related modules]
- Patterns to follow: [e.g., "see src/auth/github.js for the OAuth pattern"]
- Dependencies available: [e.g., "passport-oauth2 already installed"]
- Related issue: #N

## Done Criteria
- [Specific, verifiable items]
- [What should change]
- [What should NOT change — scope boundary]
- Tests pass

## After Implementation
Review your own work against the Done Criteria.
Check for:
- Missing requirements or edge cases
- Unnecessary complexity (can anything be simpler?)
- Stubs, TODOs, placeholder returns, or mock data left behind
- Bugs, security issues, edge cases
- Code style consistency with the existing codebase

Run tests. Fix failures. Repeat review-fix until solid.

## When Satisfied
Create a PR referencing #N with a clear description.
Do NOT merge — leave open for review.
```
