# Script Inventory and Cleanup Policy

> Superseded by `tests/skills-lint/scripts/script-reachability.test.js` for
> ongoing enforcement. The category taxonomy and Decision Notes below remain as
> historical rationale; do not refresh the full inventory table.

This document classifies runtime scripts before deleting or moving anything. The
main rule: a script with zero runtime imports is not automatically dead. It may be
an operator CLI, adapter entry point, or archived measurement tool.

## Categories

| Category | Meaning | Cleanup rule |
|----------|---------|--------------|
| Runtime entry point | Invoked by a skill workflow or documented operator command. | Keep unless the workflow is retired. Update `SKILL.md`, `README.md`, and `CLAUDE.md` together. |
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
| `scripts/smoke_dispatch_scenarios.py` | Archived measurement tool | Deleted from packaged `skills/` in #765. | Removed; dated evidence docs remain historical. |
| `scripts/claude-app-register.js` | Shared helper | Imported by the Claude executor adapter. | Keep while Claude executor registration parity exists. |
| `scripts/codex-app-register.js` | Shared helper | Imported by the Codex executor adapter. | Keep. |
| `scripts/worktree-runtime.js` | Shared helper | Imported by `dispatch.js` and `create-worktree.js`. | Keep. |
| `scripts/worktreeinclude.js` | Shared helper | Imported by `worktree-runtime.js`. | Keep or inline only if the worktree include contract stays trivial. |
| `scripts/dispatch-publish.js` | Shared helper | Imported by `dispatch.js` and `recover-commit.js`. | Keep. |
| `scripts/execution-evidence.js` | Shared helper | Imported by dispatch/recovery and mirrored in review. | Keep. |
| `scripts/exec.js` | Shared helper | Imported by dispatch, worktree, merge, and review helpers. | Keep. |
| `scripts/cli-args.js` | Shared helper | Imported across all skills. | Keep. |
| `tests/relay-dispatch/scripts/test-support.js` | Test support | Used by tests only. | Moved out of packaged `skills/` in #765. |
| `scripts/relay-events.js` | Shared helper | Event journal producer used across dispatch, review, and merge. | Keep. |
| `scripts/relay-resolver.js` | Shared helper | Manifest/run/branch resolution for dispatch, review, and merge. | Keep. |
| `scripts/relay-manifest.js` | Compatibility facade | Thin re-export facade after manifest split. | Keep until downstream imports are fully migrated or facade compatibility is intentionally retired. |
| `scripts/manifest/*.js` | Shared helper modules | State machine, manifest store, path validation, rubric anchor, cleanup, attempts, environment, PR stamping. | Keep. These are runtime contract modules, not cleanup candidates. |

### Relay Intake

| Script | Category | Evidence | Cleanup guidance |
|--------|----------|----------|------------------|
| `scripts/persist-request.js` | Runtime entry point | `/relay-ready` persistence entry point. | Keep. |
| `scripts/relay-request.js` | Shared helper | Request artifact CRUD and events. | Keep. |

### Relay Plan

| Script | Category | Evidence | Cleanup guidance |
|--------|----------|----------|------------------|
| `scripts/probe-executor-env.js` | Runtime entry point / signal producer | `/relay-plan` step 3 invokes it. | Keep. |
| `scripts/persist-done-criteria.js` | Runtime entry point | `/relay-plan` uses it to persist Phase 1 deviations. | Keep. |
| `scripts/tdd-flavor.js` | Shared helper | Imported by `tdd-suggestion.js`. | Keep. Consider renaming to a rubric parser/renderer name because it is shared outside the planner flow. |
| `scripts/tdd-suggestion.js` | Optional planner helper | Mentioned by TDD reference; not wired into default `/relay-plan` flow. | Keep while Phase 1.2 TDD mode is planned; wire or fold into `rubric-pattern-tdd-flavor.md` when #142 lands. |

### Relay Review

| Script | Category | Evidence | Cleanup guidance |
|--------|----------|----------|------------------|
| `scripts/review-runner.js` | Runtime entry point | `/relay-review` standard path. | Keep. |
| `scripts/invoke-reviewer-codex.js` | Adapter entry point | Discovered by reviewer name. | Keep while Codex reviewer is supported. |
| `scripts/invoke-reviewer-claude.js` | Adapter entry point | Discovered by reviewer name. | Keep while Claude reviewer is supported. |
| `scripts/resolve-issue-number.sh` | Optional legacy helper | `relay-review/SKILL.md` labels it legacy manual helper. | Keep only while manual fallback docs still reference it. |
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

## Cleanup Order

1. **Documented no-op pass:** keep this inventory current and add missing workflow references for tools that are intentionally public.
2. **Consumer helper decision:** choose one signal-consumption path. Do not keep tested consumer helpers that no runtime flow calls.
3. **Archived measurement move:** move one-off measurement tools out of packaged `skills/` unless they remain public operator commands.
4. **Test-support move:** move test-only helpers under `tests/` when they do not need runtime package access.

Each cleanup PR should touch one category at a time. For every deleted or moved script,
run:

```bash
rg -n '<script-basename>' skills tests README.md CLAUDE.md references docs backlog
node --test tests/<affected-skill>/scripts/*.test.js
```

## Decision Notes

- `plan-runner.js` and its `invoke-planner-*` adapters were retired from the runtime skill package because isolated planning was optional and duplicated the human-in-the-loop `/relay-plan` flow.
- `tdd-flavor.js` is a shared rubric helper despite its narrow name. It remains after `plan-runner` cleanup.
- #1033 removes `sprint-close-report.js` from the default flow but retains it as a legacy-only reader while historical Score Log manifests remain supported.
- #767 retires `update-manifest-state.js`; use `recover-state.js` as the canonical structured state recovery command.

## Retired In #766

| Script | Prior status | #766 decision |
|--------|--------------|---------------|
| `scripts/reliability-report-consumer.js` | Tested helper, unused by runtime flow. | Deleted with its dedicated test; relay-plan already consumes raw producer JSON directly. |
| `scripts/probe-executor-env-consumer.js` | Tested helper, unused by runtime flow. | Deleted with its dedicated test; relay-plan already consumes raw probe JSON directly. |
| `scripts/run-qa-loop.js` | Readiness intake helper with only dedicated test coverage. | Deleted with its dedicated test after the sequential Q&A flow was not wired into runtime intake. |
| `scripts/analyze-flip-flop-pattern.js` | Optional operator/measurement tool registered in `cli-schema.js`. | Deleted with its dedicated test and removed from the public CLI registry. |
