# Rubric Examples

## API endpoint task

```yaml
rubric:
  - name: Tests pass
    type: automated
    command: "npm test -- --grep auth"
    target: "exit 0"
    weight: critical
  - name: Endpoint works
    type: automated
    command: "curl -sf localhost:3000/auth/login"
    target: "200 OK"
    weight: critical
  - name: Security
    type: evaluated
    criteria: "httpOnly cookies, PKCE flow, no token in URL params"
    target: ">= 8/10"
    weight: high
  - name: Simplicity
    type: evaluated
    criteria: "Single middleware chain, no over-abstraction"
    target: ">= 7/10"
    weight: medium
```

## Refactoring task

```yaml
rubric:
  - name: Tests pass
    type: automated
    command: "npm test"
    target: "exit 0"
    weight: critical
  - name: No behavior change
    type: automated
    command: "npm run test:integration"
    target: "same results as before"
    weight: critical
  - name: Complexity reduction
    type: evaluated
    criteria: "Fewer files, shorter functions, removed dead code"
    target: ">= 8/10"
    weight: high
  - name: Readability
    type: evaluated
    criteria: "Clear naming, obvious flow, no clever tricks"
    target: ">= 7/10"
    weight: medium
```

## Design guidelines

### Good factors
- **Specific**: "Functions < 20 lines" not "code is clean"
- **Measurable**: Either a command to run or clear criteria to score against
- **Relevant**: Directly tied to AC items, not generic quality gates
- **Achievable**: Target scores that a single implementation pass can reach

### Bad factors
- Vague: "good code quality" (score against what?)
- Unmeasurable: "feels right" (no criteria to evaluate)
- Irrelevant: "documentation coverage" (when AC doesn't mention docs)
- Unrealistic: "100% coverage" (wastes iterations on diminishing returns)

### How many factors?
- **3-5 for a typical task**. More makes iteration slow.
- Always include at least 1 automated check (tests or linting).
- Critical weight factors should be automated where possible.
