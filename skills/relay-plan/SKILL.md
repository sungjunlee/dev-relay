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
        fix_hint:                          # optional — prescriptive "what to do next"
          low_to_mid: "Add timeouts to all external HTTP/DB calls (default 5s); wrap retries in idempotency check"
          mid_to_high: "Add exponential backoff with jitter; add circuit breaker after N=3 consecutive failures"
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
**`setup`** / **`baseline`**: Run setup commands before checks; capture baseline for delta metrics (run BEFORE changes).
**`criteria`**: Multi-line, specific bullets — not "good error handling" but "timeouts on external calls, retry with backoff."
**`scoring_guide`**: Three anchors (low/mid/high) — each tells the executor what to fix next. Shared scale between executor and reviewer. Optional `fix_hint` adds prescriptive transition guidance (low→mid, mid→high) for when descriptive anchors alone leave the executor stuck.

### Domain references (for expert perspective)

Consult `references/rubric-*.md` for specialist thinking. Design factors from AC, informed by (not copied from) references.

| Task type | Reference | Key signal |
|-----------|-----------|-----------|
| UI components, pages, interactions | `rubric-frontend.md` | Lighthouse, CLS, a11y, interaction fidelity |
| API endpoints, data layer, infra | `rubric-backend.md` | Query count, response time, failure modes |
| Code restructuring, migration | `rubric-refactoring.md` | Dead code delta, concept count, dependency direction |
| README, guides, API docs, specs | `rubric-documentation.md` | Reader testing score, zero-context completeness |
| Design-driven features, UX flows | `rubric-design.md` | Value → Usability → Delight hierarchy |

### 3. Validate the rubric

Before dispatch, verify:

- [ ] ≥ 1 automated check exists (ground truth) + commands are immutable
- [ ] Every evaluated factor has `scoring_guide` with low/mid/high anchors
- [ ] Criteria are specific ("timeouts on external calls") not vague ("good error handling")
- [ ] Criteria reference discoverable artifacts (file paths, function names, code patterns) not abstract qualities ("follows conventions", "consistent style")
- [ ] 3-5 factors total; targets are concrete ("≥ 8/10", "< 200ms") not relative
- [ ] Automated checks measure verifiable outcomes ("API < 200ms", `grep -q`, test command) not proxies ("tests pass")

Any check fails → revise. See `references/rubric-design-guide.md` for fix patterns.

### 3.5 Review the rubric (L/XL tasks)

For 5+ AC items, stress-test the rubric before dispatch. **Max 1 round**, then proceed.

| Size | AC count | Review |
|------|----------|--------|
| S/M | 1-4 | Skip |
| L | 5-6 | Stress-test: subagent games rubric (gaming vectors, coverage gaps, disappear test) |
| XL | 7+ or cross-domain | Stress-test + calibration simulation (parallel) |

Skip: S/M tasks, re-dispatches with iteration history, all-automated rubrics. Full protocol + prompt templates: `references/rubric-stress-test.md`

### 4. Generate dispatch prompt

Take the base template (`relay/references/prompt-template.md`) and add these sections:

- **Setup**: setup commands from rubric
- **Scoring Rubric**: automated checks table + evaluated factors table
- **Iteration Protocol** (autoloop-style measure-fix-keep):
  ```
  BEFORE LOOP: Run baseline if defined. RULE: Do NOT modify automated check commands.
  LOOP (max 5 iterations):
    1. Run ALL automated checks + self-evaluate ALL evaluated factors, record scores
    2. REGRESSION CHECK: Any factor previously marked locked now below target?
       → Revert this iteration's changes (git reset to previous commit)
       → Re-attempt with constraint: "Maintain [factor] at [score] while improving [target factor]"
       → Regression persists after 1 re-attempt → flag both factors, escalate
    3. Append to Score Log — mark factors that meet target as locked
    4. All required meet target → adversarial self-review:
       - Review as if you did NOT write this code and are seeing it for the first time
       - For each automated check: could the target be met by a shortcut that misses the intent?
         (e.g., stubbed endpoint returns fast but does nothing; test modified to always pass)
       - For each evaluated factor: re-read scoring_guide "high" — does it genuinely apply?
       - Check: stubs, TODOs, hardcoded values, test manipulation, placeholder returns
       → All clear → PR
       → Issues found → fix → re-score → PR
    5. Else → lowest required factor → if fix_hint exists, apply it as the starting fix → ONE focused change → commit → repeat
    6. Stuck detection (any trigger → best-effort: note in PR, continue | required: stop, create PR with partial progress):
       a) Single-factor stall: same factor below target for 3 consecutive iterations
       b) Oscillation: any two factors alternate regression across 4+ iterations
       c) Plateau: no required factor improved toward target over 2 consecutive iterations
  ```
- **Score Log**: iteration scores table in PR description (reviewer re-scores independently):
  ```
  | Factor | Target | Baseline | Iter 1 | Iter 2 | Final | Status |
  |--------|--------|----------|--------|--------|-------|--------|
  ```
  Status: `—` (not met), `locked` (met target — must not regress in subsequent iterations)

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
