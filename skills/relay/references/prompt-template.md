# Prompt Template (Base)

> Simplified version. For rubric-enhanced prompts with automated checks and scored factors, use relay-plan instead.

```markdown
[What to implement]

## Context
- Relevant files: [entry points, related modules]
- Patterns to follow: [e.g., "see src/auth/github.js for the OAuth pattern"]
- Dependencies available: [e.g., "passport-oauth2 already installed"]
- Related issue: #N

## Available Tools
[Output from probe-executor-env.js — include if probe was run]
- Agent skills: [e.g., /browse, /playwright-cli]
- MCP tools: [e.g., sequential-thinking]
- Project: [e.g., npm test, npm run lint, make build]
Use these tools during implementation and self-review iteration.

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
