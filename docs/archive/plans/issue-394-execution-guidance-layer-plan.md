# Issue #394 - Execution Guidance Layer for Relay Dispatch

Planning note for Epic #394 and child issues #395-#400. This document captures the design reasoning so each implementation issue can reference the same source instead of reconstructing the prompt/workflow research from scratch.

## Problem statement

Relay already has the important hard contract:

- Done Criteria are recovered before dispatch.
- Rubrics define the measurable target before code is written.
- Executors self-score.
- Reviewers re-score in a fresh context.
- Manifests and events preserve the lifecycle contract.

The missing layer is the executor's working style. The planner often knows that a task is a bugfix, docs change, refactor, trust-boundary change, or prompt/template change, but that judgment currently lives in the planner's head and in ad hoc prompt wording. The dispatched worker gets the rubric, but not always the compact task-specific habits that make the work better: surgical diffs, red-first tests when appropriate, simplify pass after green checks, reader-success checks for docs, or stronger verification evidence.

That creates three problems:

| Problem | Impact |
|---------|--------|
| Task type is implicit | Later reviewers and reliability reports cannot tell why a worker received certain guidance. |
| Guidance is ad hoc | Prompt quality depends on the orchestrator's memory instead of a reusable relay convention. |
| Guidance is not measured | We cannot tell whether TDD, simplify, docs, or trust-boundary guidance reduces review rounds. |

## Goal

Add an **Execution Guidance Layer** inside `relay-plan` and `relay-dispatch`:

1. `relay-plan` derives a first-class `task_profile`.
2. `relay-plan` selects compact `guidance_packs` from the profile.
3. The dispatch prompt renders only selected guidance packs.
4. `relay-dispatch` persists the selected packs as advisory metadata.
5. `reliability-report` summarizes whether packs correlate with better convergence.

This is a prompt-quality layer, not a new workflow engine.

## Architecture

```text
Task source / Intake / Issue
        |
        v
relay-plan
  - recover Done Criteria
  - read probe + historical signals
  - build task_profile
  - build rubric factors
  - select guidance_packs
        |
        v
dispatch prompt
  - Context
  - Done Criteria
  - Available Tools
  - Working Guidance, compact
  - Scoring Rubric
  - Iteration Protocol
  - Completion Evidence
        |
        v
relay-dispatch
  - persist rubric
  - persist prompt
  - persist guidance metadata/event
        |
        v
relay-review / reliability-report
  - reviewer scores rubric
  - report guidance_pack effectiveness
```

## Proposed task profile

First cut:

```yaml
task_profile:
  size: S | M | L | XL
  change_type: bugfix | feature | refactor | docs | test | infra | visual | prompt
  domains:
    - backend
    - cli
    - docs
    - relay-manifest
  risk_tags:
    - trust-boundary
    - state-machine
    - migration
    - public-api
  execution_mode: quick | standard | fresh-context | batch-wave
  guidance_packs:
    - surgical-change
    - verification-evidence
    - simplify-pass
```

The profile is planner metadata. It must not become a reviewer verdict field, and it must not mutate role bindings in the manifest.

## Guidance pack contract

Guidance packs are **candidate working-style snippets**, not full skills and not rubrics.

Rules:

- Keep each rendered pack compact, usually 5-10 lines.
- Use executor-agnostic wording. Do not require Codex-only or Claude-only skill names.
- Do not override Done Criteria, rubric commands, scope boundaries, or user instructions.
- Promote important outcomes into rubric factors. Guidance only shapes how the executor works.
- Persist selected pack names so the reliability report can measure outcomes.

Example prompt shape:

```markdown
## Working Guidance

These instructions guide execution style. They do not override Done Criteria, rubric commands, or scope boundaries.

### surgical-change
- Keep the diff narrow. Every changed line should trace to Done Criteria, rubric factors, or cleanup caused by your own edits.
- Prefer existing local patterns over new abstractions.
- Do not refactor adjacent code unless your change made it necessary.

### verification-evidence
- Before completion, record the exact commands run and their results.
- Treat tests, manifests, and self-reports as evidence, not proof by themselves.
- If a required factor is still failing after focused attempts, stop with a stuck note instead of broadening scope.
```

## Initial guidance packs

### `surgical-change`

Default for most code tasks.

Use when:

- Any source code changes are expected.
- The task is S/M and scope creep is the main risk.

Do not use as a substitute for rubric factors. It should reduce accidental edits, not define correctness.

### `verification-evidence`

Default for all dispatches with implementation work.

Use when:

- The executor must commit final work.
- The reviewer needs concrete proof artifacts.

Expected completion evidence:

```markdown
## Completion Evidence
- Changed artifacts:
- Commands run:
- Failing-before evidence, if TDD factor:
- Passing-after evidence:
- Known gaps/blockers:
```

### `simplify-pass`

Default for M+ code tasks and refactors. Optional for S mechanical tasks.

Use when:

- The task touches non-trivial implementation code.
- The change creates new helpers, branches, parsing, prompt rendering, or state handling.

Guidance:

- After green checks, review only files changed in this task.
- Preserve behavior exactly.
- Reduce unnecessary branching, duplicate logic, and single-use abstractions.
- Prefer explicit readable code over dense clever code.

### `docs-reader-success`

Use for documentation, README, operator guide, and skill/reference text changes.

Guidance:

- Verify referenced files, commands, flags, and issue numbers exist when practical.
- Make the doc usable by a reader with zero conversation context.
- Prefer runnable examples or clearly mark illustrative examples.
- Promote link checks, command checks, or artifact existence checks into automated rubric factors where practical.

### `trust-boundary`

Use for tasks touching manifest validation, state transitions, review gates, auth boundaries, or trust roots.

Guidance:

- Identify the trust root explicitly.
- Distinguish visible warnings from fail-closed enforcement.
- Use external reference evidence when validating claims.
- Add regression tests for forged, missing, stale, or mismatched inputs.

This pack should pair with `references/rubric-trust-model.md`; it does not replace it.

## Lessons from workflow systems

The useful pattern from Superpowers, GSD, Oh My OpenAgent, and Oh My Codex is not "add more prompt text." The useful pattern is:

| Pattern | Relay adaptation |
|---------|------------------|
| Phase separation | Keep relay's existing plan -> dispatch -> review -> merge boundaries. |
| Fresh context per worker | Preserve dispatch worktree isolation and review fresh-context isolation. |
| Explicit task routing | Add `task_profile` and selected `guidance_packs`. |
| Evidence before completion | Add compact completion evidence guidance and reviewer-visible artifacts. |
| Human-readable state | Keep manifest/event files as the audit trail. |
| Context rot prevention | Keep packs compact and avoid full skill injection. |

Do not copy runtime-heavy features like hook ownership, HUDs, tmux team orchestration, or permission-skipping defaults into relay. Relay's product is manifest-backed handoff and independent review, not a general agent harness.

## External references reviewed

- OpenAI prompt guidance for GPT-5.5: direct, scoped instructions; agentic persistence; structured prompt sections; avoid over-broad "maximize context" prompts on small tasks.
- Anthropic Claude prompting best practices: clear task context, explicit tool-use direction, structured tags, state tracking, incremental progress, safety boundaries.
- Codex skills documentation: progressive disclosure. Start with skill metadata and load full instructions only when needed. Relay should mirror this by selecting compact guidance packs instead of injecting full skills.
- Superpowers: brainstorming, worktree isolation, detailed plans, TDD, two-stage review, verification before completion.
- GSD: discuss -> plan -> execute -> verify -> ship; phase artifacts; fresh context per plan; atomic commits.
- Oh My OpenAgent / Oh My Codex: intent routing, role/category selection, lifecycle continuation, doctor/smoke-test boundaries, and explicit proof boundaries.

## Out of scope

- Full skill loader for executor prompts.
- Runtime hooks, HUD, tmux team runtime, or auto-continuation loop.
- New executor adapter.
- Reviewer verdict schema changes for guidance packs.
- Making guidance mandatory where no task-specific evidence supports it.
- Moving correctness requirements out of rubric factors into prose guidance.

## Child issue map

| Issue | Purpose |
|-------|---------|
| #395 | Add `task_profile` to relay-plan guidance model. |
| #396 | Add compact guidance pack references. |
| #397 | Render `Working Guidance` in dispatch prompts. |
| #398 | Persist selected guidance packs in artifacts/events. |
| #399 | Add guidance pack insights to reliability-report. |
| #400 | Document the layer and examples. |

## Test plan

Minimum coverage for this epic:

```text
CODE PATH COVERAGE
==================
[+] relay-plan prompt generation
    |-- no guidance pack selected keeps existing prompt stable
    |-- selected packs render compact Working Guidance
    |-- TDD pack still only activates via tdd_anchor
    `-- unsupported executor does not receive provider-specific skill names

[+] guidance selection
    |-- docs task selects docs-reader-success
    |-- code task selects surgical-change + verification-evidence
    |-- refactor task selects simplify-pass
    `-- trust-boundary task selects trust-boundary guidance

[+] manifest / events
    |-- selected guidance_packs are persisted
    `-- reliability-report groups outcomes by guidance_pack
```

Verification commands:

```bash
node --test tests/relay-plan/scripts/*.test.js
node --test tests/relay-dispatch/scripts/*.test.js
```

## Implementation order

1. #395 first. The profile is the dependency for everything else.
2. #396 next. Packs should exist before prompt rendering.
3. #397 renders packs into the prompt. Keep no-pack fixtures byte-stable.
4. #398 persists metadata/events after prompt semantics are stable.
5. #399 reads the persisted data.
6. #400 updates docs after the behavior lands, using this note as source material.

## Review notes

Key review questions:

- Does the implementation keep guidance advisory and rubric authoritative?
- Can a Claude executor and a Codex executor both follow the prompt without platform-specific skill names?
- Does no-guidance behavior remain unchanged?
- Are selected packs observable in run history?
- Can reliability-report handle old runs without guidance metadata?
