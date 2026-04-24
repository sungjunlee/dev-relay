---
name: relay-plan
argument-hint: "[issue-number]"
description: Convert task acceptance criteria into a scored rubric for autonomous iteration. Always used before relay-dispatch — rubric depth scales with task size.
compatibility: Requires gh CLI. Task AC reading falls back to local files or user input.
metadata:
  related-skills: "relay, relay-intake, relay-dispatch, relay-review, dev-backlog"
---

# Relay Plan

Build a scoring rubric from task Acceptance Criteria (AC), then generate a dispatch prompt that drives autonomous iteration until convergence.

## Process

### 1. Read the task

Read the normalized task source (try in order, use first that succeeds):
- Relay-ready handoff brief from relay-intake: `~/.relay/requests/<repo-slug>/<request-id>/relay-ready/<leaf-id>.md`
- Local task file: `backlog/tasks/{PREFIX}-{N} - {Title}.md`
- GitHub: `gh issue view <N>`
- User-provided description

If relay-intake already produced a handoff brief, treat that file as the source of truth instead of re-reading the raw request.

### 1.5 Read historical signal

Before designing the rubric, read relay reliability history:

```bash
node ${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/reliability-report.js --repo . --json
```

Use `historical_signal.stuck_factors`, `historical_signal.divergence_hotspots`, and `historical_signal.avg_rounds` to tighten factor wording, calibration examples, and review guidance. The signal does not gate dispatch, alter state transitions, or modify rubric structure. Empty-history and failure cases are rendered as `no historical data available`. Full field mapping + case handling: `references/signals.md` § Historical signal.

### 1.6 Read probe quality signals

Before designing the rubric, read repo-local quality signals:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/probe-executor-env.js . --project-only --json
```

Use `probe_signal.test_infra`, `probe_signal.lint_format`, `probe_signal.type_check`, `probe_signal.ci`, and `probe_signal.scripts` to inform rubric design, prerequisite naming, and Available Tools context. The planner picks what fits the task — the signal exposes data, it does not pick for them. No-signal and failure cases are rendered as `no quality infra detected`. Full field mapping + case handling: `references/signals.md` § Probe signal.

### 2. Build the rubric

Use the guided interview (`references/rubric-design-guide.md`) to derive factors from AC, or convert directly:

```yaml
rubric:
  setup: "npm install && npm start &"              # run before checks (if needed)
  baseline: "npm run metrics > baseline.json"      # capture before-state (if delta metrics used)

  prerequisites:                                    # repo-wide hygiene; must all pass; uncounted
    - command: "npm test"
      target: "exit 0"
    - command: "npx tsc --noEmit"
      target: "exit 0"

  factors:                                          # substantive checks (contract + quality)
    - name: API returns cursor-paginated response
      tier: contract
      type: automated
      command: "curl -s localhost:3000/api/items?limit=10 | jq '.next_cursor'"
      target: "non-null cursor string"
      weight: required

    - name: Pagination robustness
      tier: quality
      type: evaluated
      criteria: |
        - Last page: returns empty array + no next cursor (not null, not error)
        - Concurrent writes: cursor stable when items inserted/deleted mid-pagination
        - Large result set: query plan uses index scan (EXPLAIN ANALYZE)
        - Cursor opacity: cursor is encoded, not raw DB id exposed to client
      scoring_guide:
        low: "Happy path works, last page returns error or null cursor"
        mid: "Last page handled, but cursor is raw ID, no query plan check"
        high: "All four criteria met, cursor is opaque, query uses index"
      target: ">= 8/10"
      weight: required
```

Tier classification (hygiene / contract / quality), `type` = `automated` vs `evaluated`, and `weight` = `required` vs `best-effort`: see `references/rubric-design-guide.md` § Guided Interview. `setup`/`baseline` run before checks; `criteria` must be specific bullets; `scoring_guide` provides three anchors (low/mid/high) that executor and reviewer share.

### Domain references (for expert perspective)

Consult `references/rubric-*.md` for specialist thinking. Design factors from AC, informed by (not copied from) references.

| Task type | Reference | Key signal |
|-----------|-----------|-----------|
| UI components, pages, interactions | `rubric-frontend.md` | Lighthouse, CLS, a11y, interaction fidelity |
| API endpoints, data layer, infra | `rubric-backend.md` | Query count, response time, failure modes |
| User input, auth, file uploads, APIs with sensitive data | `rubric-security.md` | Trust boundaries, auth coverage, injection resistance, exposure control |
| Code restructuring, migration | `rubric-refactoring.md` | Dead code delta, concept count, dependency direction |
| README, guides, API docs, specs | `rubric-documentation.md` | Reader testing score, zero-context completeness |
| Design-driven features, UX flows | `rubric-design.md` | Value → Usability → Delight hierarchy |

### Trust-model audit factor (auth-boundary tasks)

If the task crosses an auth boundary (label `phase-0-follow-up`; keywords trust root, anchor, invariant, grandfather, validate, forge, bypass, gate-check, auth-boundary; or any `validateTransition*` / `validateManifest*` / `evaluateReviewGate` callsite), follow `references/rubric-trust-model.md`. Each of the three questions (who forges? where is the gate? what verifies?) becomes a **named factor**, not a criterion bullet. Record the answers under `### Trust-model audit` in the PR body before dispatch. This reference sharpens `rubric-security.md` — use both.

### 3. Validate the rubric

Quick gate before dispatch:

- Prerequisites hold repo-wide hygiene only; factors stay substantive (tier test)
- Contract/Quality tier minimums met for task size (S/M/L/XL)
- ≥ 1 automated check across prerequisites + factors
- Every evaluated factor has `scoring_guide` with low/mid/high anchors
- Criteria are specific and reference discoverable artifacts; targets are concrete

Full validation checklist, factor count rules, Rubric Quality Card examples, grading (A/B/C/D), and risk signals: `references/rubric-validation.md`. Grade D = revise before dispatch; Grade C = warn and make the tradeoff explicit.

### 3.4 Simplify the rubric

Before persisting the draft rubric, apply the 6 heuristics in `references/rubric-simplification.md`.

This applies to all task sizes; do not gate it on S/M vs L/XL. Rewrite prescriptive HOW language into observable WHAT, merge overlapping factors, remove unsupported defensive clauses, and verify weights before dispatch.

### 3.45 Optional isolated planner draft

For standalone opt-in planner isolation, generate draft artifacts without changing the default `/relay` flow:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/plan-runner.js \
  --issue 42 --planner codex --repo . --out-dir /tmp/relay-plan-42 --json
```

This writes `rubric.yaml`, `dispatch-prompt.md`, and `planner-notes.md` under the output directory. The orchestrator still reviews and may edit the draft before dispatch.

### 3.5 Review the rubric (L/XL tasks)

- **S/M (1-4 AC)**: skip
- **L (5-6 AC)**: stress-test (max 1 round) — subagent games rubric (gaming vectors, coverage gaps, disappear test, Padding Test)
- **XL (7+ or cross-domain)**: stress-test + calibration simulation (parallel)

Skip: re-dispatches with iteration history, all-automated rubrics. Full protocol + prompt templates: `references/rubric-stress-test.md`.

### 4. Generate dispatch prompt

Take the base template (`../relay/references/prompt-template.md`) and append:

- **Setup** — setup commands from rubric
- **Scoring Rubric** — automated checks table + evaluated factors table
- **Iteration Protocol** — measure-fix-keep loop with regression check, adversarial self-review, and stuck detection
- **Score Log** — iteration scores table appended to the PR description (reviewer re-scores independently)

Full iteration-protocol text + Score Log format: `references/iteration-protocol.md`.

### 5. Dispatch

Write the rubric YAML to a temp file alongside the dispatch prompt. Every relay dispatch must pass `--rubric-file` so the rubric is persisted at `anchor.rubric_path` for review and merge gates.

```bash
${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/dispatch.js . \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml --timeout 3600
```

## When to use

All tasks dispatched via relay. S/M = lightweight rubric (1-5 factors), skip stress-test. L/XL = detailed rubric with stress-test and calibration. Re-dispatches automatically prepend previous Score Log + reviewer feedback to the prompt (see `relay-dispatch` docs). Full rubric guide: `references/rubric-design-guide.md`.
