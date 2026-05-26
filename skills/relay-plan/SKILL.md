---
name: relay-plan
argument-hint: "[task, issue, or ready handoff]"
description: Synthesize task intent, explicit AC when present, repo signals, and task risk into a scored rubric for autonomous iteration. Always used before relay-dispatch — rubric depth scales with task size.
compatibility: Requires gh CLI.
metadata:
  related-skills: "relay, relay-ready, relay-dispatch, relay-review, dev-backlog"
  keywords: "계획, 루브릭, planning, rubric, dispatch prompt"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`; Step 7/8 examples use `RUN_ID`.
- Files: relay-ready handoff, task file, issue/user text, optional local harness context (`AGENTS.md`, `CLAUDE.md`, `CHARTER.md`, `spec/capabilities.md`, active sprint notes), optional `/tmp/done-criteria-<N>.md`, `/tmp/dispatch-<N>.md`, and `/tmp/rubric-<N>.yaml`.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/reliability-report.js`, `${RELAY_SKILL_ROOT:-skills}/relay-plan/scripts/probe-executor-env.js`, `${RELAY_SKILL_ROOT:-skills}/relay-plan/scripts/persist-done-criteria.js`, `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`.

# Relay Plan

## Use when

- Building the review anchor, scored rubric, and dispatch prompt for a relay run
- Converting task intent, explicit AC, repo signals, and risk into reviewable Done Criteria
- Persisting planner-authored Done Criteria before dispatch

## Do not use when

- Shaping an ambiguous task before planning — use `relay-ready`
- Delegating implementation to an executor — use `relay-dispatch`
- Reviewing executor output — use `relay-review`
- Merging a reviewed PR — use `relay-merge`

`relay-plan` emits handoff artifacts only; `relay` or an operator runs `relay-dispatch`.

## Default Path

### 1. Read the task

Read the normalized task source (try in order, use first that succeeds):
- Relay-ready handoff brief: `~/.relay/requests/<repo-slug>/<request-id>/relay-ready/<leaf-id>.md`
- Local task file: `backlog/tasks/{PREFIX}-{N} - {Title}.md`
- GitHub: `gh issue view <N>`
- User-provided description

If `relay-ready` produced a handoff brief, treat it as the source of truth instead of re-reading the raw request.

### 2. Gather planning signals

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/reliability-report.js" --repo . --json
```

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-plan/scripts/probe-executor-env.js" . --project-only --json
```

Read historical relay signal, repo-local quality signal, and task-relevant local harness context as weak inputs only. They inform wording, prerequisites, commands, and where to look; they do not gate dispatch or override the task. Empty/failure cases render as `no historical data available` or `no quality infra detected`; field meanings and authority hierarchy: `references/signals.md`.

### 3. Normalize planning inputs

Keep explicit AC, inferred Done Criteria, relay-ready handoff, project harness context, repo signal, historical signal, optional subsystem scout notes, and task risk as separate evidence channels until the review anchor is written.

### 4. Recover Done Criteria

Identify the evaluation source model:
- Explicit AC from the task source, when present
- Inferred Done Criteria from user intent, issue body, relay-ready handoff, and nearby repo conventions
- Repo/historical signals from probes, available commands, stuck factors, and score divergence
- Task-specific risk from touched domains, trust boundaries, data loss, migrations, UX flows, or operational failure modes

If AC are missing, vague, or incomplete, write observable Done Criteria first. Treat explicit AC as high-priority evidence, not the only source. Before freezing, run the [pre-flight ambiguity audit](references/dc-preflight-audit.md). If the final review anchor is planner-authored or differs from the task source, persist it in step 7.

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

Size the rubric by task risk and ambiguity, not raw issue AC count: **S** uses 1 contract factor and may skip quality factors; **M** uses 3-5 factors; **L** uses 4-6 factors; **XL** uses 5-8 factors. Tier classification, `type`, `weight`, `setup`/`baseline`, `criteria`, `scoring_guide`, and optional `tdd_anchor` / `tdd_runner`: `references/rubric-design-guide.md`.

### 6. Validate and simplify the rubric

Quick gate before handoff: prerequisites hold repo-wide hygiene only; factors stay substantive; contract/quality tier minimums match task size; at least one automated check exists; every evaluated factor has low/mid/high `scoring_guide`; criteria and targets are concrete. Full checklist: `references/rubric-validation.md`.

Before persisting, apply `references/rubric-simplification.md`: rewrite HOW into observable WHAT, merge overlaps, remove unsupported defensive clauses, and verify weights.

### 7. Persist planner-authored Done Criteria when needed

Persist only when planning writes the final Done Criteria, or expands, rejects, or narrows issue-body AC. This includes AC-missing inputs, user-provided descriptions, and any case where planning changes the issue-body AC.

Before Step 7, the orchestrator/planner must allocate the `RUN_ID` that dispatch will later reuse. Use the same valid run id in this persistence command and in Step 8's `relay-dispatch --run-id "$RUN_ID"` handoff; if no Done Criteria persistence is needed, dispatch may allocate the run id itself.

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-plan/scripts/persist-done-criteria.js" --repo . \
  --run-id "$RUN_ID" --file /tmp/done-criteria-<N>.md --json
```

Skip this step when the issue or relay-ready handoff already provides the final Done Criteria without planner changes.

### 8. Emit handoff artifacts

Write the dispatch prompt and rubric YAML to temp files. The prompt uses `../relay/references/prompt-template.md` and appends Setup, optional Working Guidance, Scoring Rubric, Iteration Protocol, and Score Log sections. Full iteration protocol and Score Log format: `references/iteration-protocol.md`.

Return a handoff summary with dispatch prompt path, rubric YAML path, Done Criteria anchor path when persisted, review assurance level, and the recommended `relay-dispatch` command, including `--run-id "$RUN_ID"` and `--done-criteria-file <done-criteria-path>` when Step 7 persisted Done Criteria. Use `--review-assurance hardened` only when task/rubric risk requires stronger verification; never derive it from executor or reviewer identity.

When Step 7 persisted Done Criteria, the dispatch handoff must preserve both anchors:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . \
  --run-id "$RUN_ID" --prompt-file /tmp/dispatch-<N>.md --rubric-file /tmp/rubric-<N>.yaml \
  --done-criteria-file <done-criteria-path>
```

Do not run `relay-dispatch` from `relay-plan`.

## Risk-Triggered Add-Ons

Use these only when their trigger applies:

| Trigger | Add-on |
|---|---|
| Probe signal matches a template | Ask `scripts/match-template.js` for a scaffold; never auto-apply. Templates live in `references/rubric-templates/`. |
| Task profile suggests specialized working guidance | Derive `task_profile` per `references/task-profile.md`; selected pack names and prompt-ready guidance bullets come from `references/guidance-packs.md`. |
| Need domain-specific rubric ideas | Consult the relevant section in `references/rubric-domain-axes.md` for frontend, backend, security, refactoring, documentation, or design thinking. |
| Task crosses auth or state-machine trust boundaries | Follow `references/rubric-trust-model.md`; each answered risk question becomes a named factor. |
| Task touches gates, resolvers, recovery, audit stamps, locks, or deadlines | Apply `references/rubric-fail-closed-patterns.md`. |
| Factor names file paths, test names, or grep tokens | Apply `references/rubric-patterns.md#rubric-pattern--file-path-and-grep-token-precision`. |
| Edit scope is narrower than the repo | Apply `references/rubric-patterns.md#rubric-pattern--explicit-forbidden-zones`. |
| Event schema evolves | Apply `references/rubric-patterns.md#rubric-pattern--event-shape-changes`. |
| Red-first factor is useful | Apply `references/rubric-patterns.md#rubric-pattern--tdd-factor-flavor`; emit the optional Step 0a only when a factor has `tdd_anchor`. |
| Task is L/XL, high ambiguity, or subsystem boundaries are unclear before Done Criteria recovery | Consider a read-only subsystem scout per `references/subsystem-scout.md`; skip for S/M tasks with clear scope. |
| Done Criteria are novel, vague, high-risk, or easy to game | Run one stress-test round per `references/rubric-stress-test.md`; S/M usually skip, but ambiguity or risk can opt any size into stress-test. |
| Re-dispatch after review feedback | Previous Score Log and reviewer feedback are automatically prepended; keep the original anchor fixed. |
