---
milestone: model-freedom-dispatch-subtraction
status: completed
started: 2026-08-14
due: TBD
component: "dispatch-execution"
---

# Model-Freedom Dispatch Subtraction

## Goal

Make the routine trusted-local dispatch path executor/model/task-shaped: Relay stops inferring intent from prompt text, removes policy escape-hatch ceremony, and leaves models free inside the retained worktree while deterministic verification, review, and merge boundaries remain strict.

## Plan

### Batch 1 — Remove speculative prompt admission

- [x] #1251 — remove prompt-regex toolset admission, `--allow-toolset-mismatch`, the shell-free planning fork, and unused capability metadata

### Batch 2 — Remove normal-path policy ceremony

- [x] #1252 — default trusted-local networking to the normal usable path and remove the misleading public dispatch sandbox choice (depends on #1251)

## Running Context

- Models may choose their own implementation and iteration strategy inside the retained worktree. Relay enforces immutable input, process cleanup, external verification, exact-SHA independent review, and explicit merge at boundaries.
- #1244 established complete failed verification as a canonical exact-current redispatch path. That observable path replaces prompt-text guesses about whether an executor can satisfy the work.
- Subtraction is the objective: do not replace removed prompt regexes or policy flags with a smarter classifier, profile registry, mode switch, fact, or lifecycle.
- Batch order is strict because both issues touch dispatch, fleet, planning/docs, and their contract tests.

## Progress

- 2026-08-14 — Admitted the two-issue subtraction sprint after #1250 planning. Created #1251 and #1252 from live runtime evidence; closed obsolete checkpoint-sidecar proposal #838 as contrary to the fact-based fresh-review contract.
- 2026-08-14 — Completed #1251 in PR #1255. Removed prompt-text admission, its public/fleet escape hatch, the shell-free planning fork, and unused adapter capability metadata. The final exact head passed 637/637 serialized tests and all 11 GitHub checks; a scheduler-sensitive provider natural-exit race found by CI was corrected by requiring repeated live observations instead of one elapsed-wall-time observation.
- 2026-08-14 — Completed #1252 in PR #1256. Trusted-local dispatch and redispatch now default tool networking to enabled, the public and fleet sandbox choice is removed, and each adapter/phase owns its truthful native filesystem request. The full serialized gate exited 0, final focused cleanup passed 38/38 with zero skips, independent Spec/Standards/simplification reviews and bound Codex review were LGTM, and all 11 GitHub checks passed.
