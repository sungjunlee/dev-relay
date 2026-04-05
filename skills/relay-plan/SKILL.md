---
name: relay-plan
argument-hint: "[issue-number]"
description: Convert task acceptance criteria into a scored rubric for autonomous iteration. Use before relay-dispatch for tasks with 3+ acceptance criteria or quality-sensitive work.
compatibility: Requires gh CLI. Task AC reading falls back to local files or user input.
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

Use the guided interview (`references/rubric-design-guide.md`) to derive factors from AC, or convert directly:

```yaml
rubric:
  setup: "npm install && npm start &"    # run before checks (if needed)
  baseline: "npm run metrics > baseline.json"  # capture before-state (if delta metrics used)
  factors:
    - name: Response time
      type: automated
      command: "curl -w '%{time_total}' -so /dev/null localhost:3000/api/users"
      target: "< 0.2s (and ≤ baseline)"
      weight: required

    - name: Failure mode design
      type: evaluated
      criteria: |
        - Graceful degradation: slow downstream → timeout + partial response, not cascade
        - Retry strategy: backoff + jitter on idempotent ops only, never on mutations
        - Circuit breaking: fail fast after N failures, don't wait for timeout every time
        - Error messages: tell the caller what they can do, not just "500 Internal Server Error"
      scoring_guide:
        low: "No timeouts on external calls, retry-on-everything, errors swallowed silently"
        mid: "Timeouts on external calls, basic retry without backoff or jitter"
        high: "All four criteria met, edge cases handled (partial degradation, idempotency-aware retry)"
      target: ">= 8/10"
      weight: required

    - name: API contract clarity
      type: evaluated
      criteria: |
        - Consistent field naming across endpoints (created_at everywhere, not mixed with createdAt)
        - Structured error responses: same JSON shape for 4xx and 5xx, not HTML on 500
        - Paginated by default: any list endpoint without pagination is an incident waiting for data
        - No breaking changes to existing callers without explicit versioning
      scoring_guide:
        low: "Inconsistent naming, plaintext errors, unbounded list responses"
        mid: "Consistent naming and error schema, but no pagination or versioning awareness"
        high: "All four criteria met, contract is predictable and safe for existing callers"
      target: ">= 7/10"
      weight: best-effort
```

| Type | How scored |
|------|-----------|
| **automated** | Run command, check output/exit code. Measure the actual outcome, not a proxy. |
| **evaluated** | Agent reads code and scores 1-10. `criteria` lists what to check (multi-line, detailed). `scoring_guide` provides 3 calibration anchors (low/mid/high) so executor and reviewer share the same scale. Think like a domain expert, not a checklist. |

| Weight | Rule |
|--------|------|
| **required** | Must meet target before PR. No cross-factor compensation — each evaluated independently. |
| **best-effort** | Note in PR if below target |
**`setup`**: Commands to run before automated checks (start server, seed DB). Omit if not needed.
**`baseline`**: Capture before-state for delta metrics. Run checks BEFORE changes; improvement is keep, regression is discard.
**`criteria`**: Multi-line, specific. Each bullet is a concrete thing to check, not "good error handling" but "timeouts on external calls, retry with backoff on idempotent ops only."
**`scoring_guide`**: Three calibration anchors — `low` (failure), `mid` (partially met), `high` (target zone). Each level tells the executor what to fix next. Shared scale between executor and reviewer.

### Domain references (for expert perspective)

After designing factors, consult the matching `references/rubric-*.md` for specialist thinking you may have missed. Design factors from the task's AC, informed by (not copied from) the reference.

| Task type | Reference | Key signal |
|-----------|-----------|-----------|
| UI components, pages, interactions | `rubric-frontend.md` | Lighthouse, CLS, a11y, interaction fidelity |
| API endpoints, data layer, infra | `rubric-backend.md` | Query count, response time, failure modes |
| Code restructuring, migration | `rubric-refactoring.md` | Dead code delta, concept count, dependency direction |
| README, guides, API docs, specs | `rubric-documentation.md` | Reader testing score, zero-context completeness |
| Design-driven features, UX flows | `rubric-design.md` | Value → Usability → Delight hierarchy |

### 3. Validate the rubric

Before dispatch, verify:

- [ ] ≥ 1 automated check exists (ground truth — evaluated-only rubrics have no anchor)
- [ ] Automated check commands are immutable — executor must not modify them
- [ ] Every evaluated factor has `scoring_guide` with low/mid/high anchors (prevents generous self-scoring)
- [ ] Criteria are specific ("timeouts on external calls") not vague ("good error handling")
- [ ] 3-5 factors total (more slows iteration without adding signal)
- [ ] Targets are concrete ("≥ 8/10", "< 200ms") not relative ("good", "fast")
- [ ] Automated checks measure outcomes ("API < 200ms") not proxies ("tests pass")

Any check fails → revise before proceeding. See `references/rubric-design-guide.md` for fix patterns and optional calibration protocol.

### 4. Generate dispatch prompt

Take the base template (`relay/references/prompt-template.md`) and add these sections:

- **Setup**: setup commands from rubric
- **Scoring Rubric**: automated checks table + evaluated factors table
- **Iteration Protocol** (autoloop-style measure-fix-keep):
  ```
  BEFORE LOOP: If baseline is defined, run it now. Save output for delta comparison.
  RULE: Do NOT modify automated check commands. They are immutable ground truth. Fix the code, not the check.

  LOOP (max 5 iterations):
    1. Run ALL automated checks, record each score (compare to baseline if delta target)
    2. Self-evaluate ALL evaluated factors, record each score (1-10)
    3. Append scores to the Score Log (keep ALL iterations, not just final)
    4. All required factors meet target →
       Final self-review: verify Done Criteria item-by-item, scan for stubs/TODOs, confirm tests pass; issues? fix → step 1 →
       create PR with full Score Log
    5. Else → identify lowest required factor → make ONE focused fix → commit → repeat
    6. Stuck on same factor 3 consecutive iterations →
       - best-effort: note in PR, continue to next factor
       - required: stop iteration, create PR with Score Log showing failure, flag for human review
  ```
- **Score Log**: table in PR description showing each iteration's scores (reviewer will re-score independently):
  ```
  | Factor | Target | Baseline | Iter 1 | Iter 2 | Final |
  |--------|--------|----------|--------|--------|-------|
  | Response time | < 0.2s | 0.18s | 0.35s | 0.15s | 0.15s |
  | Failure mode design | ≥ 8 | — | 5 | 8 | 8 |
  ```

### 5. Dispatch

```bash
${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/dispatch.js . \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --timeout 3600 --copy-env
```

## When to use

- **Use it**: 3+ AC items, quality-sensitive work, executor delegation
- **Skip it**: Bug fixes, typos, one-liners — dispatch directly with base template
- **Re-dispatch**: Previous Score Log + reviewer feedback are automatically prepended to the prompt (see `relay-dispatch` docs)
- **Full rubric guide**: `references/rubric-design-guide.md`
