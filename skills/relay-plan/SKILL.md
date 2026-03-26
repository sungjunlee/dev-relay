---
name: relay-plan
description: Convert task acceptance criteria into a scored rubric for autonomous iteration. Defines measurable factors (automated commands + agent-evaluated scores) with target thresholds, then generates a dispatch prompt where Codex loops until all factors converge. Use before relay-dispatch to build a quality contract. Inspired by autoresearch's program.md pattern.
metadata:
  related-skills: relay, relay-dispatch, relay-review, dev-backlog
---

# Relay Plan

Build a scoring rubric from task AC, then generate a dispatch prompt that drives autonomous iteration until convergence.

## Concept

```
autoresearch                     relay-plan
  program.md                       rubric (this skill generates it)
  val_bpb (single metric)          multi-factor scores (automated + agent-evaluated)
  LOOP: modify → train → measure   LOOP: implement → score → improve lowest → re-score
  keep/discard by metric           converge when ALL factors meet target
```

## Process

### 1. Read the task

Read the issue AC (from dev-backlog task file or GitHub issue directly).

### 2. Build the rubric

Convert each AC item into a scored factor. Classify as **automated** or **evaluated**:

```yaml
rubric:
  - name: Test suite
    type: automated
    command: "npm test 2>&1 | tail -5"
    target: "all pass (exit code 0)"
    weight: critical  # blocks everything if failing

  - name: Test coverage
    type: automated
    command: "npm run test:coverage 2>&1 | grep 'All files' | awk '{print $10}'"
    target: ">= 90"
    weight: high

  - name: API correctness
    type: automated
    command: "curl -s localhost:3000/auth/login | jq '.code_challenge' | grep -v null"
    target: "non-empty output"
    weight: critical

  - name: Code simplicity
    type: evaluated
    criteria: "No unnecessary abstractions. Functions < 20 lines. Single responsibility."
    target: ">= 7/10"
    weight: medium

  - name: Security posture
    type: evaluated
    criteria: "Tokens in httpOnly cookies. No secrets in code. Input validation on all endpoints."
    target: ">= 8/10"
    weight: high

  - name: Style consistency
    type: evaluated
    criteria: "Naming, patterns, file structure match existing codebase."
    target: ">= 7/10"
    weight: medium
```

### Factor types

| Type | How scored | Examples |
|------|-----------|----------|
| **automated** | Run command, check output/exit code | tests, coverage, linting, curl, benchmarks |
| **evaluated** | Agent reads code and scores 1-10 | simplicity, security, design, readability |

### Weight levels

| Weight | Meaning | Convergence rule |
|--------|---------|-----------------|
| **critical** | Must pass. No exceptions. | Blocks PR creation |
| **high** | Must meet target score | Must converge before PR |
| **medium** | Should meet target | Best-effort; note in PR if below target |

### 3. Generate dispatch prompt

Combine the rubric into a dispatch prompt for relay-dispatch:

```markdown
[What to implement — from issue description]

## Context
[Relevant files, patterns, deps — from codebase reading]

## Done Criteria
[Readable list — from AC]

## Scoring Rubric

After implementation, score yourself on these factors.
Iterate until ALL critical/high factors meet their target.

### Automated Checks (run these commands)
| Factor | Command | Target |
|--------|---------|--------|
| Test suite | `npm test 2>&1 \| tail -5` | exit code 0 |
| Coverage | `npm run test:coverage 2>&1 \| grep 'All files'` | >= 90% |
| API check | `curl -s localhost:3000/auth/login \| jq .code_challenge` | non-null |

### Evaluated Factors (self-assess 1-10)
| Factor | Criteria | Target |
|--------|----------|--------|
| Code simplicity | No unnecessary abstractions, functions < 20 lines | >= 7 |
| Security | httpOnly cookies, no secrets, input validation | >= 8 |
| Style | Match existing codebase patterns | >= 7 |

## Iteration Protocol

LOOP until converged:
1. Run ALL automated checks. Fix failures first (critical weight).
2. Self-evaluate all evaluated factors. Score each 1-10.
3. If any critical/high factor is below target:
   - Identify the lowest-scoring factor
   - Fix it specifically
   - Re-run checks and re-evaluate
   - Repeat
4. When ALL critical/high factors meet target:
   - Log final scores in a comment at top of PR description
   - Create PR. Do NOT merge.

If stuck on a factor after 3 attempts, note it in PR description and move on.

## Score Log Format

Track each iteration in your PR description:

```
## Scores
| Iteration | Tests | Coverage | API | Simplicity | Security | Style |
|-----------|-------|----------|-----|------------|----------|-------|
| 1         | FAIL  | -        | -   | -          | -        | -     |
| 2         | PASS  | 78%      | OK  | 6/10       | 7/10     | 8/10  |
| 3         | PASS  | 92%      | OK  | 8/10       | 8/10     | 8/10  |
```
```

### 4. Dispatch

Pass the generated prompt to relay-dispatch.

## Rubric Design Guidelines

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

## Examples

### Example: API endpoint task

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

### Example: Refactoring task

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

## After Codex (Claude's turn)

When relay-review runs after Codex creates the PR:
1. Read the Score Log from PR description
2. Verify automated scores (re-run if needed)
3. Re-evaluate the evaluated factors independently (fresh eyes)
4. Use simplify/review skills for additional quality checks
5. If Claude's scores differ significantly from Codex's self-assessment → flag for re-dispatch
