---
name: relay-plan
argument-hint: "[issue-number]"
description: Synthesize task intent, explicit AC when present, repo signals, and task risk into a scored rubric for autonomous iteration. Always used before relay-dispatch — rubric depth scales with task size.
compatibility: Requires gh CLI.
metadata:
  related-skills: "relay, relay-ready, relay-dispatch, relay-review, dev-backlog"
---

# Relay Plan

Build a scoring rubric from the task's intended outcome: explicit Acceptance Criteria (AC) when available, inferred Done Criteria when missing or incomplete, repo quality signals, historical relay signal, and task-specific risk. Then generate a dispatch prompt that drives autonomous iteration until convergence.

## Process

### 1. Read the task

Read the normalized task source (try in order, use first that succeeds):
- Relay-ready handoff brief from the relay-ready skill: `~/.relay/requests/<repo-slug>/<request-id>/relay-ready/<leaf-id>.md`
- Local task file: `backlog/tasks/{PREFIX}-{N} - {Title}.md`
- GitHub: `gh issue view <N>`
- User-provided description

If the relay-ready skill already produced a handoff brief, treat that file as the source of truth instead of re-reading the raw request.

### 2. Read historical signal

Before designing the rubric, read relay reliability history:

```bash
node ${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/reliability-report.js --repo . --json
```

Use `historical_signal.stuck_factors`, `divergence_hotspots`, and `avg_rounds` to tighten factor wording and calibration. The signal does not gate dispatch or alter state. Empty/failure cases render as `no historical data available`; details: `references/signals.md`.

### 3. Read probe quality signals

Before designing the rubric, read repo-local quality signals:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/probe-executor-env.js . --project-only --json
```

Use `probe_signal.test_infra`, `lint_format`, `type_check`, `ci`, and `scripts` to inform rubric design, prerequisites, and Available Tools. The signal exposes data; it does not pick. No-signal/failure cases render as `no quality infra detected`; details: `references/signals.md`. The `test_infra` field is consumed by `references/rubric-pattern-tdd-flavor.md` and `scripts/tdd-suggestion.js`.

Optionally, ask `match-template.js` for a deterministic starter template based on the probe signal:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/match-template.js --probe-file /tmp/probe.json --json
```
The result is a SUGGESTION the planner accepts, modifies, or rejects. NEVER auto-apply. Templates are SCAFFOLDS; planners must fill placeholder fields. Templates live in `references/rubric-templates/`; signal field meanings stay in `references/signals.md`.

### 4. Recover Done Criteria

Before drafting factors, identify the evaluation source model:
- Explicit AC from the task source, when present
- Inferred Done Criteria from user intent, issue body, relay-ready handoff, and nearby repo conventions
- Repo quality signal from probes and available commands
- Historical relay signal from stuck factors and score divergence
- Task-specific risk from touched domains, trust boundaries, data loss, migrations, UX flows, or operational failure modes; derive `task_profile` per `references/task-profile.md`
- Selected guidance pack names from `task_profile.guidance_packs`, using `references/guidance-packs.md` as the compact advisory pack library

If AC are missing, vague, or incomplete, write observable Done Criteria first. Treat explicit AC as high-priority evidence, not the only source. Before freezing, run the [pre-flight ambiguity audit](references/dc-preflight-audit.md) — it catches the spec-precision wording issues responsible for nearly every R1 changes_requested round. If the final review anchor is planner-authored or differs from the task source, persist it in step 8 so the reviewer has the same anchor.

### 5. Build the rubric

Use the guided interview (`references/rubric-design-guide.md`) to synthesize factors from the recovered Done Criteria, or convert directly:

```yaml
rubric:
  prerequisites:
    - command: "npm test"
      target: "exit 0"
  factors:
    - name: API returns cursor-paginated response
      tier: contract
      type: automated
      command: "curl -s localhost:3000/api/items?limit=10 | jq '.next_cursor'"
      target: "non-null cursor string"
      weight: required
    - name: Pagination robustness
      tier: quality
      type: evaluated
      criteria: "Last page works; cursor is opaque and stable under writes."
      scoring_guide: { low: "happy path only", mid: "last page handled", high: "opaque stable cursor" }
      target: ">= 8/10"
      weight: required
```

Tier classification, `type`, `weight`, `setup`/`baseline`, `criteria`, `scoring_guide`, and optional per-factor `tdd_anchor` / `tdd_runner`: see `references/rubric-design-guide.md`. For event-schema evolution, use the [event-shape rubric pattern](references/rubric-pattern-event-shape.md). For red-first factor opt-in, use the [TDD factor flavor pattern](references/rubric-pattern-tdd-flavor.md). For factors that name file paths, test names, or grep tokens, use the [grep-token precision pattern](references/rubric-pattern-grep-token-precision.md). For dispatches whose edit scope is narrower than the whole repo, use the [forbidden-zones pattern](references/rubric-pattern-forbidden-zones.md) to enumerate read-only paths.

### Domain references

Consult `references/rubric-*.md` for frontend, backend, security, refactoring, documentation, and design thinking. Design factors from task-specific evidence and risk, informed by references.

### Trust-model audit factor (auth-boundary tasks)

If the task crosses an auth boundary (trust root, anchor, invariant, validate, forge, bypass, gate-check, auth-boundary, or `validateTransition*` / `validateManifest*` / `evaluateReviewGate`), follow `references/rubric-trust-model.md`. Each question becomes a named factor. Record answers under `### Trust-model audit` in the PR body before dispatch.

### Fail-closed pattern library

If the task touches relay gates, resolver selectors, recovery paths, audit stamps, or lock/deadline fallthrough behavior, apply `references/rubric-fail-closed-patterns.md`. Use it to split visible warnings from blocking enforcement and to enumerate sibling states, selectors, call sites, and downstream consumers.

### 6. Validate the rubric

Quick gate before dispatch: prerequisites hold repo-wide hygiene only; factors stay substantive; contract/quality tier minimums match task size; S-size mechanical tasks may use 1 contract factor and no quality factor; ≥ 1 automated check exists; every evaluated factor has low/mid/high `scoring_guide`; criteria and targets are concrete.

Full checklist, counts, grading, and risk signals: `references/rubric-validation.md`. Grade D = revise; Grade C = warn and state the tradeoff.

### 7. Simplify the rubric

Before persisting the draft rubric, apply the 6 heuristics in `references/rubric-simplification.md`.

Apply to all task sizes: rewrite HOW into observable WHAT, merge overlaps, remove unsupported defensive clauses, and verify weights.

### 8. Persist planner-authored Done Criteria

Persist now so the optional review in §9 sees the same anchor as the reviewer will; persistence is not a commitment, just an anchor write.
If operator planning writes the final Done Criteria, persist that decision before dispatch so fresh-context review uses the same anchor. This includes AC-missing inputs, user-provided descriptions, and any case where planning expands, rejects, or narrows issue-body AC:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/persist-done-criteria.js --repo . \
  --run-id "$RUN_ID" --file /tmp/done-criteria-<N>.md --json
```

Dispatch with the same `RUN_ID` and `--done-criteria-file ~/.relay/runs/<repo-slug>/$RUN_ID/done-criteria.md`. Skip this step only when the issue or relay-ready handoff already provides the final Done Criteria without planner changes.

### 9. Review the rubric (triggered by ambiguity/risk)

S/M usually skips, but ambiguity or risk can opt any size into stress-test. Run stress-test for L/XL rubrics with evaluated factors and an ambiguity/risk signal, and for smaller rubrics when the recovered Done Criteria are novel, vague, or easy to game. XL adds calibration simulation only when novel or subjective evaluated factors need it. Skip re-dispatches with iteration history, all-automated rubrics, and simple tasks where recovered Done Criteria map cleanly to checks. Protocol: `references/rubric-stress-test.md`.

### 10. Generate dispatch prompt

Take the base template (`../relay/references/prompt-template.md`) and append Setup, optional `task_profile` metadata plus Working Guidance when guidance packs are selected, Scoring Rubric, Iteration Protocol, and Score Log sections. Selected pack names and prompt-ready guidance bullets come from `references/guidance-packs.md`; the Working Guidance section is advisory and must state that it does not override Done Criteria, rubric commands, or scope boundaries. Insert the optional Step 0a block from `references/iteration-protocol.md` iff any factor has a non-empty `tdd_anchor`; when no factor has `tdd_anchor`, keep the emitted prompt identical to the pre-TDD baseline.

Full iteration-protocol text + Score Log format: `references/iteration-protocol.md`.

### 11. Dispatch

Write the rubric YAML to a temp file alongside the dispatch prompt. Every relay dispatch must pass `--rubric-file` so the rubric is persisted at `anchor.rubric_path` for review and merge gates.

```bash
node ${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/dispatch.js . \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml --timeout 3600
```

## When to use

All tasks dispatched via relay. Rubric depth scales with orchestrator judgment on recovered Done Criteria, file scope, ambiguity, and risk, not raw issue AC count: **S** simple tasks use 1 contract factor and skip stress-test; **M** uses 3-5 factors and skips stress-test; **L** uses 4-6 factors and stress-tests only with evaluated factors plus ambiguity/risk; **XL** uses 5-8 factors and adds calibration only when useful.

Re-dispatches automatically prepend previous Score Log + reviewer feedback. Full rubric guide: `references/rubric-design-guide.md`.
