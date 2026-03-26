---
name: relay-plan
description: Convert task acceptance criteria into a scored rubric for autonomous iteration. Defines automated checks and agent-evaluated factors with target thresholds. Codex loops until all factors converge. Use before relay-dispatch to build a quality contract.
metadata:
  related-skills: "relay, relay-dispatch, relay-review, dev-backlog"
---

# Relay Plan

Build a scoring rubric from task Acceptance Criteria (AC), then generate a dispatch prompt that drives autonomous iteration until convergence.

## Process

### 1. Read the task

Read the issue AC (from dev-backlog task file or GitHub issue).

### 2. Build the rubric

Convert each AC item into a scored factor. Classify as **automated** or **evaluated**:

```yaml
rubric:
  setup: "npm install && npm start &"  # run before automated checks (if needed)
  factors:
    - name: Test suite
      type: automated
      command: "npm test 2>&1 | tail -5"
      target: "exit 0"
      weight: required

    - name: Code simplicity
      type: evaluated
      criteria: "No unnecessary abstractions. Functions < 20 lines."
      target: ">= 7/10"
      weight: required

    - name: Style consistency
      type: evaluated
      criteria: "Naming, patterns match existing codebase."
      target: ">= 7/10"
      weight: best-effort
```

| Type | How scored | Examples |
|------|-----------|----------|
| **automated** | Run command, check output/exit code | tests, coverage, linting, curl, benchmarks |
| **evaluated** | Agent reads code and scores 1-10 | simplicity, security, design, readability |

| Weight | Convergence rule |
|--------|-----------------|
| **required** | Must meet target before PR creation |
| **best-effort** | Note in PR if below target |

**`setup` field**: Commands to run before automated checks (e.g., start server, seed DB). Skipped if empty.

### 3. Generate dispatch prompt

Embed the rubric into a dispatch prompt. Use the base template from `relay/references/prompt-template.md` and add:

```markdown
## Setup (run once before checks)
[setup command from rubric]

## Scoring Rubric

After implementation, score yourself on these factors.
Iterate until ALL required factors meet their target.

### Automated Checks (run these commands)
| Factor | Command | Target |
|--------|---------|--------|
| [from rubric automated factors] |

### Evaluated Factors (self-assess 1-10)
| Factor | Criteria | Target |
|--------|----------|--------|
| [from rubric evaluated factors] |

## Iteration Protocol

LOOP (max 5 iterations):
1. Run setup command if needed.
2. Run ALL automated checks. Fix failures first.
3. Self-evaluate all evaluated factors. Score each 1-10.
4. If any required factor is below target:
   - Fix the lowest-scoring factor specifically
   - Re-run checks and re-evaluate
   - Repeat
5. If stuck on the same factor for 3 consecutive attempts, note it and move on.
6. When ALL required factors meet target:
   - Log final scores in PR description
   - Create PR. Do NOT merge.

## Score Log

Include in PR description:
| Factor | Target | Score | Status |
|--------|--------|-------|--------|
| Tests  | exit 0 | PASS  | ✓      |
| Security | >= 8 | 8/10  | ✓      |
| Style  | >= 7   | 6/10  | best-effort, noted |
```

### 4. Dispatch

Pass the generated prompt to relay-dispatch:
```bash
./scripts/dispatch.js . -b issue-42 --prompt-file /tmp/dispatch-42.md --timeout 3600 --copy-env
```

## When to use relay-plan

- **Use it**: Tasks with 3+ AC items, quality-sensitive work, delegation to Codex
- **Skip it**: Simple bug fixes, typos, one-liner changes — dispatch directly with the base template

## Examples and guidelines

See `references/rubric-examples.md` for concrete rubric examples and design guidelines.

## Aim for 3-5 factors per task. Always include at least 1 automated check.
