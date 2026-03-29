---
name: relay-plan
argument-hint: "[issue-number]"
description: Convert task acceptance criteria into a scored rubric for autonomous iteration. Defines automated checks and agent-evaluated factors with target thresholds. Codex loops until all factors converge. Use before relay-dispatch for tasks with 3+ acceptance criteria.
compatibility: gh CLI recommended for issue reading (fallback: local task file or user-provided AC).
metadata:
  related-skills: "relay, relay-dispatch, relay-review, dev-backlog"
---

# Relay Plan

Build a scoring rubric from task Acceptance Criteria (AC), then generate a dispatch prompt that drives autonomous iteration until convergence.

## Process

### 1. Read the task

Read the issue AC (try in order, use first that succeeds):
- Local task file: `backlog/tasks/{PREFIX}-{N} - {Title}.md`
- GitHub: `gh issue view <N>`
- User-provided description

### 2. Build the rubric

Convert each AC item into a scored factor:

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

| Type | How scored |
|------|-----------|
| **automated** | Run command, check output/exit code (tests, coverage, curl, linting) |
| **evaluated** | Agent reads code and scores 1-10 (simplicity, security, design) |

| Weight | Rule |
|--------|------|
| **required** | Must meet target before PR creation |
| **best-effort** | Note in PR if below target |

**`setup`**: Commands to run before automated checks (start server, seed DB). Omit if not needed.

### 3. Generate dispatch prompt

Take the base template (`relay/references/prompt-template.md`) and add these sections:

- **Setup**: setup commands from rubric
- **Scoring Rubric**: automated checks table + evaluated factors table
- **Iteration Protocol** (autoloop-style measure-fix-keep):
  ```
  LOOP (max 5 iterations):
    1. Run ALL automated checks, record each score
    2. Self-evaluate ALL evaluated factors, record each score (1-10)
    3. Append scores to the Score Log (keep ALL iterations, not just final)
    4. All required factors meet target → create PR with full Score Log
    5. Else → identify lowest required factor → make ONE focused fix → commit → repeat
    6. Stuck on same factor 3 consecutive iterations → note and move on
  ```
- **Score Log**: table in PR description showing each iteration's scores. This is the shared metric between Codex self-review and Claude's relay-review — Claude will re-run automated checks and re-score evaluated factors independently.
  ```
  | Factor | Target | Iter 1 | Iter 2 | Iter 3 | Final |
  |--------|--------|--------|--------|--------|-------|
  | Tests  | exit 0 | FAIL   | PASS   | PASS   | PASS  |
  | Security | ≥8  | 6      | 8      | 8      | 8     |
  ```

### 4. Dispatch

```bash
${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/dispatch.js . \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --timeout 3600 --copy-env
```

## When to use

- **Use it**: 3+ AC items, quality-sensitive work, Codex delegation
- **Skip it**: Bug fixes, typos, one-liners — dispatch directly with base template

## Aim for 3-5 factors. Always include at least 1 automated check.

See `references/rubric-examples.md` for examples and design guidelines.
