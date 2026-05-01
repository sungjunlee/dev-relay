# Script Inventory and Cleanup Policy

This document classifies runtime scripts before deleting or moving anything. The
main rule: a script with zero runtime imports is not automatically dead. It may be
an operator CLI, adapter entry point, or archived measurement tool.

## Categories

| Category | Meaning | Cleanup rule |
|----------|---------|--------------|
| Runtime entry point | Invoked by a skill workflow or documented operator command. | Keep unless the workflow is retired. Update `SKILL.md`, `README.md`, `CLAUDE.md`, and `cli-schema.js` together. |
| Adapter entry point | Invoked by naming convention from another runtime script. | Keep if the adapter is supported. Deleting requires removing discovery references and tests. |
| Shared helper | Imported by one or more runtime scripts. | Keep. Rename or move only with import-site migration and focused tests. |
| Test support | Imported by tests only. | Keep outside packaged runtime when possible; otherwise document why runtime placement is required. |
| Optional operator tool | Documented but not part of the default relay path. | Keep only if a skill or reference doc explains when to run it. |
| Archived measurement tool | One-off analysis retained for evidence or reproducibility. | Prefer moving to `docs/` or `references/` unless it is still an operator command. |
| Decision needed | Current references do not prove the script earns runtime install weight. | Decide keep/promote, document-only, or delete in a focused PR. |

## Current Inventory

### Relay Dispatch

| Script | Category | Evidence | Cleanup guidance |
|--------|----------|----------|------------------|
| `scripts/dispatch.js` | Runtime entry point | `/relay-dispatch`, `/relay-plan`, and `/relay` route through it. | Keep. This is the worker handoff boundary. |
| `scripts/create-worktree.js` | Optional operator tool | Documented in operator utilities; used for standalone worktree creation. | Keep while `create-worktree --register` remains supported. |
| `scripts/cleanup-worktrees.js` | Optional operator tool | Documented in README, CLAUDE.md, and operator utilities. | Keep. Runtime imports are not expected. |
| `scripts/close-run.js` | Optional operator tool | Used by cleanup output and documented recovery flows. | Keep. |
| `scripts/recover-commit.js` | Optional operator tool | Canonical recovery for executor completed without commit/PR. | Keep. |
| `scripts/recover-state.js` | Optional operator tool | Canonical structured state recovery command. | Keep. |
| `scripts/update-manifest-state.js` | Decision needed | Public CLI in `cli-schema.js`, tests, and historical docs; not the canonical recovery path. | Either deprecate in favor of `recover-state.js` or document the remaining use case. Do not delete silently. |
| `scripts/reliability-report.js` | Optional operator tool / planner signal producer | `/relay-plan` reads it before rubric design. | Keep. |
| `scripts/smoke_dispatch_scenarios.py` | Archived measurement tool | Referenced from scenario-test docs only. | Move out of packaged `skills/` if it is no longer a shipped operator tool. |
| `scripts/claude-app-register.js` | Shared helper | Imported by `dispatch.js`. | Keep while Claude executor registration parity exists. |
| `scripts/codex-app-register.js` | Shared helper | Imported by `worktree-runtime.js`. | Keep. |
| `scripts/worktree-runtime.js` | Shared helper | Imported by `dispatch.js` and `create-worktree.js`. | Keep. |
| `scripts/worktreeinclude.js` | Shared helper | Imported by `worktree-runtime.js`. | Keep or inline only if the worktree include contract stays trivial. |
| `scripts/dispatch-publish.js` | Shared helper | Imported by `dispatch.js` and `recover-commit.js`. | Keep. |
| `scripts/execution-evidence.js` | Shared helper | Imported by dispatch/recovery and mirrored in review. | Keep. |
| `scripts/model-hints.js` | Shared helper | Imported by `dispatch.js`. | Keep while model hints exist. |
| `scripts/rubric-size.js` | Shared helper | Imported by `dispatch.js`. | Keep. |
| `scripts/exec.js` | Shared helper | Imported by dispatch, worktree, merge, and review helpers. | Keep. |
| `scripts/cli-args.js` | Shared helper | Imported across all skills. | Keep. |
| `scripts/cli-schema.js` | Shared helper / public registry | Imported by `cli-args.js`. | Keep and update when public CLIs are added or removed. |
| `scripts/test-support.js` | Test support | Used by tests only. | Consider moving under `tests/` if packaged install weight matters. |
| `scripts/relay-events.js` | Shared helper | Event journal producer used across dispatch, review, and merge. | Keep. |
| `scripts/relay-resolver.js` | Shared helper | Manifest/run/branch resolution for dispatch, review, and merge. | Keep. |
| `scripts/relay-manifest.js` | Compatibility facade | Thin re-export facade after manifest split. | Keep until downstream imports are fully migrated or facade compatibility is intentionally retired. |
| `scripts/manifest/*.js` | Shared helper modules | State machine, manifest store, path validation, rubric anchor, cleanup, attempts, environment, PR stamping. | Keep. These are runtime contract modules, not cleanup candidates. |

### Relay Intake

| Script | Category | Evidence | Cleanup guidance |
|--------|----------|----------|------------------|
| `scripts/persist-request.js` | Runtime entry point | `/relay-intake` persistence entry point. | Keep. |
| `scripts/relay-request.js` | Shared helper | Request artifact CRUD and events. | Keep. |

### Relay Plan

| Script | Category | Evidence | Cleanup guidance |
|--------|----------|----------|------------------|
| `scripts/probe-executor-env.js` | Runtime entry point / signal producer | `/relay-plan` step 3 invokes it. | Keep. |
| `scripts/persist-done-criteria.js` | Runtime entry point | `/relay-plan` uses it to persist Phase 1 deviations. | Keep. |
| `scripts/plan-runner.js` | Decision needed | Optional isolated planner; not default relay flow. | Decide whether isolated planning is a supported product surface. If no, remove with `invoke-planner-*` and `cli-schema` entries. |
| `scripts/invoke-planner-codex.js` | Adapter entry point / decision needed | Used only by `plan-runner.js`. | Keep only if `plan-runner.js` stays. |
| `scripts/invoke-planner-claude.js` | Adapter entry point / decision needed | Used only by `plan-runner.js`. | Keep only if `plan-runner.js` stays. |
| `scripts/tdd-flavor.js` | Shared helper | Imported by `reliability-report.js`, `sprint-close-report.js`, `plan-runner.js`, and `tdd-suggestion.js`. | Keep. Consider renaming to a rubric parser/renderer name because it is no longer plan-runner-only. |
| `scripts/tdd-suggestion.js` | Decision needed | Mentioned by `SKILL.md` and TDD reference, but not wired into the default planner flow. | Either wire it into `/relay-plan` output or fold the heuristic into `rubric-pattern-tdd-flavor.md`. |
| `scripts/reliability-report-consumer.js` | Decision needed | Tested and documented, but current `SKILL.md` reads raw producer output. | Either make `/relay-plan` or `plan-runner.js` consume it, or retire the helper and keep the contract in docs. |
| `scripts/probe-executor-env-consumer.js` | Decision needed | Same shape as reliability consumer. | Same decision: wire into flow or retire. |

### Relay Review

| Script | Category | Evidence | Cleanup guidance |
|--------|----------|----------|------------------|
| `scripts/review-runner.js` | Runtime entry point | `/relay-review` standard path. | Keep. |
| `scripts/invoke-reviewer-codex.js` | Adapter entry point | Discovered by reviewer name. | Keep while Codex reviewer is supported. |
| `scripts/invoke-reviewer-claude.js` | Adapter entry point | Discovered by reviewer name. | Keep while Claude reviewer is supported. |
| `scripts/resolve-issue-number.sh` | Optional legacy helper | `relay-review/SKILL.md` labels it legacy manual helper. | Keep only while manual fallback docs still reference it. |
| `scripts/analyze-flip-flop-pattern.js` | Archived measurement tool / optional operator tool | Phase A evidence tool for issue 270; registered in `cli-schema.js`. | Decide whether it remains a supported operator command. If not, move to reference/archive docs and remove CLI registry. |
| `scripts/review-schema.js` | Shared helper | Used by reviewer adapters and verdict parsing. | Keep. |
| `scripts/reviewer-helpers.js` | Shared helper | Used by reviewer adapters. | Keep. |
| `scripts/review-runner/*.js` | Shared helper modules | Stage modules for the review runner facade. | Keep. Treat as private implementation modules of `review-runner.js`. |

### Relay Merge

| Script | Category | Evidence | Cleanup guidance |
|--------|----------|----------|------------------|
| `scripts/gate-check.js` | Runtime entry point | `/relay-merge` step 0. | Keep. |
| `scripts/finalize-run.js` | Runtime entry point | `/relay-merge` step 1. | Keep. |
| `scripts/review-gate.js` | Shared helper | Used by gate-check and finalize. | Keep. |
| `scripts/relay-reconcile-artifact.js` | Optional operator tool | Documented bootstrap artifact reconciliation path. | Keep while bootstrap exemption remains supported. |
| `scripts/sprint-close-report.js` | Optional operator tool / decision needed | Recently added and tested; not yet referenced by `relay-merge/SKILL.md`. | Promote by documenting the sprint-close invocation, or move out of packaged runtime if it stays manual/research-only. |

## Cleanup Order

1. **Documented no-op pass:** keep this inventory current and add missing workflow references for tools that are intentionally public.
2. **Plan-runner decision:** either promote isolated planning as a supported flow or remove `plan-runner.js`, `invoke-planner-*`, and related CLI schema entries together.
3. **Consumer helper decision:** choose one signal-consumption path. Do not keep tested consumer helpers that no runtime flow calls.
4. **Archived measurement move:** move one-off measurement tools out of packaged `skills/` unless they remain public operator commands.
5. **Test-support move:** move test-only helpers under `tests/` when they do not need runtime package access.

Each cleanup PR should touch one category at a time. For every deleted or moved script,
run:

```bash
rg -n '<script-basename>' skills tests README.md CLAUDE.md references docs backlog
node --test tests/<affected-skill>/scripts/*.test.js
```

If `cli-schema.js` changes, also run:

```bash
node --test tests/relay-dispatch/scripts/cli-schema.test.js
```

## Decision Notes

- `tdd-flavor.js` is a shared rubric helper despite its narrow name. Do not delete it as part of `plan-runner` cleanup.
- `sprint-close-report.js` is not dead code just because it lacks runtime imports. It landed as a report-only operator utility and needs a workflow reference or explicit archival decision.
- `update-manifest-state.js` overlaps with `recover-state.js`, but overlap is not proof of dead code. It needs a deprecation decision because it remains in the public CLI schema.
- `analyze-flip-flop-pattern.js` has the highest install-weight question: it is large, evidence-oriented, and registered as a command. Decide whether reproducibility belongs in the runtime skill package.
