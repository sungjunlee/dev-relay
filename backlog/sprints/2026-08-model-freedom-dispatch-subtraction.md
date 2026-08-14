---
milestone: model-freedom-dispatch-subtraction
status: active
started: 2026-08-14
due: TBD
component: "dispatch-execution"
---

# Model-Freedom Dispatch Subtraction

## Goal

Make the routine trusted-local dispatch path executor/model/task-shaped: Relay stops inferring intent from prompt text, removes policy escape-hatch ceremony, and leaves models free inside the retained worktree while deterministic verification, review, and merge boundaries remain strict.

## Plan

### Batch 1 — Remove speculative prompt admission

- [ ] #1251 — remove prompt-regex toolset admission, `--allow-toolset-mismatch`, the shell-free planning fork, and unused capability metadata

### Batch 2 — Remove normal-path policy ceremony

- [ ] #1252 — default trusted-local networking to the normal usable path and remove the misleading public dispatch sandbox choice (depends on #1251)

## Running Context

- Models may choose their own implementation and iteration strategy inside the retained worktree. Relay enforces immutable input, process cleanup, external verification, exact-SHA independent review, and explicit merge at boundaries.
- #1244 established complete failed verification as a canonical exact-current redispatch path. That observable path replaces prompt-text guesses about whether an executor can satisfy the work.
- Subtraction is the objective: do not replace removed prompt regexes or policy flags with a smarter classifier, profile registry, mode switch, fact, or lifecycle.
- Batch order is strict because both issues touch dispatch, fleet, planning/docs, and their contract tests.

## Progress

- 2026-08-14 — Admitted the two-issue subtraction sprint after #1250 planning. Created #1251 and #1252 from live runtime evidence; closed obsolete checkpoint-sidecar proposal #838 as contrary to the fact-based fresh-review contract.
