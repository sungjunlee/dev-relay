---
milestone: relay-runtime-core-reset-vnext
status: active
started: 2026-07-31
due: TBD
component: "dispatch-execution"
---

# Relay Runtime Core Reset vNext

## Goal

Complete GitHub epic #1129 end to end without using Relay orchestration: preserve every current executor, replace mutable lifecycle state with immutable facts and derived actions, converge recovery, retire unnecessary runtime policy, and finish with a verified 14–18-file / 4,000–6,000-line dispatch runtime.

## Plan

### Batch 1 — Safety foundation

- [x] #1130 — executable invariants, runtime inventory, and test deletion ledger (2–3 days) [branch:codex/relay-runtime-core-reset-vnext]

### Batch 2 — Parallel core replacements

- [x] #1131 — durable host/exclusion contract and crash drills (3–5 days; depends on #1130)
- [x] #1132 — immutable fact store and shadow lifecycle fold (4–6 days; depends on #1130)
- [x] #1133 — universal executor adapter protocol and migration of all current executors (4–6 days; depends on #1130)
- [x] #1134 — delete routing, assurance, analytics, and CLI runtime accretion (3–5 days; depends on #1130)

### Batch 3 — Recovery convergence

- [ ] #1135 — read-only `inspect` and idempotent `recover` (4–6 days; depends on #1131 and #1132)

### Batch 4 — Dispatch rewrite and legacy runtime deletion

- [ ] #1136 — dispatch rewrite and legacy runtime deletion (5–8 days; depends on #1131–#1135). The cutover half was withdrawn on 2026-08-03: the migration overlay was deleted rather than exercised, so there is no cutover to perform and no retirement gate to satisfy.

### Batch 5 — Program closure

- [ ] #1129 — full serialized verification, issue closure evidence, sprint close, and Relay-versus-direct-orchestration retrospective

## Direct Orchestration Protocol

This sprint deliberately does not invoke `relay`, `relay-plan`, `relay-dispatch`, `relay-review`, `relay-merge`, or `relay-fleet` as orchestration tools.

For every implementation issue:

1. Freeze the issue acceptance criteria and relevant repository invariants before editing.
2. Assign one implementation owner and explicit file boundaries.
3. Require executable verification and a concise evidence summary.
4. Review with a fresh-context model family that did not implement the change.
5. Classify every finding as blocking, non-blocking, or incorrect with file/line evidence.
6. Fix all blocking findings and repeat independent review.
7. Mark the issue complete only after the reviewer returns LGTM and all acceptance checks pass.
8. Re-read live GitHub and repository state before beginning a dependent issue.

### Model allocation

- Bounded inventory, fixtures, and mechanical edits: Terra `high`; Luna `xhigh` only when available through a verified route.
- Cross-component implementation and migration: Sol `medium` or Terra `high`, selected by blast radius and test feedback.
- Architecture-sensitive or long-horizon implementation: Sol `high` when medium effort cannot close a concrete evidence gap.
- Independent review: a different family, preferring Claude Opus 5 `high`/`xhigh`; use Pi with Qwen 3.8 Max Preview or OpenCode with GLM 5.2 as additional adversarial review when their live route is available.
- External preview-model output never overrides tests or repository evidence and cannot be the sole LGTM.

### Review loop record

For each issue, append:

- implementation model and effort;
- reviewer model and effort;
- review round count;
- blocking findings found/fixed;
- tests and measurements;
- final LGTM evidence;
- elapsed time and notable orchestration friction.

## Running Context

- The detailed contract is `docs/plans/2026-07-31-relay-runtime-core-reset-vnext.md`.
- Batch 2 tasks may begin only after #1130 is LGTM. They are conceptually parallel, but shared-file ownership must be assigned before concurrent edits.
- GitHub #1129 is the umbrella; #1130–#1136 are canonical work items.
- Executor diversity is a preserved platform capability, not a simplification target.
- Current supported executors: Codex, Claude, Cursor, OpenCode, Pi, Antigravity, and Cline.
- Do not count code moved to another installed skill as deletion.
- Do not remove legacy detach behavior before the replacement passes survival and crash gates.
- Do not rewrite terminal historical runs.
- This sprint itself is the experiment log for comparing direct model orchestration with Relay.

## Progress

- 2026-07-31 — Created the active sprint from #1129–#1136. `/goal` objective activated. Dedicated branch `codex/relay-runtime-core-reset-vnext` created. Batch 1 (#1130) marked in flight. Relay orchestration explicitly disabled for the experiment.
- 2026-07-31 — Completed #1130. Terra high and Sol medium split the inventory, ledger, and executable-contract implementation. Six fresh-context native review rounds found and closed gaps in dynamic invocation discovery, per-registration ledger accounting, measured E2E baselines, semantic reader roles, behavioral no-op rejection, and closed event schemas. Claude Opus 5 high produced no verdict before its 30-minute hard timeout; Pi/Qwen 3.8 Max Preview returned LGTM with one non-blocking recommendation, which was implemented as an automated no-op rejection meta-test. Final native verdict: LGTM.
- 2026-07-31 — #1130 evidence: 149 shipped artifacts, 156 cross-skill static imports, 22 dynamic invocation edges, 128 relay test files, and 2,179 registration sites are fail-closed and machine-accounted. Ten dispatch and ten recovery E2E samples observed zero failures; medians were 28,281 ms and 7,736 ms. The focused final gate passed 79 tests with 12 intentional vNext TODO gates and zero failures, including all eight nested manifest suites that CI previously omitted.
- 2026-07-31 — Full-suite baseline remains independently red before production changes: an interrupted 37-minute serialized run and an isolated rerun reproduced four existing advisory-lane cleanup failures (`reap_failed` versus `reaped`) in `advisory-lane-pid-reuse-996.test.js` and `cleanup-worktrees.test.js`. #1130 changes no production lifecycle behavior; the failures are recorded rather than conflated with this foundation change. Direct-orchestration friction so far: long silent external-model calls, one 30-minute reviewer timeout, and a very slow legacy serialized suite made bounded supervision and explicit evidence bookkeeping necessary.
- 2026-08-01 — #1131 reached native LGTM after replacing fixed-path locks and recursive guards with immutable owner generations and one authenticated terminal decision per generation. Root verification on the final snapshot passed facts/ownership/concurrency 31/31, crash/supervisor 15/15, launcher-exit 20/20, and detached startup 100/100 with zero launchd service growth. The experiment also exposed a major simplification warning: `host.js` is 2,568 lines and must be reduced during cutover rather than treated as the final lightweight shape.
- 2026-08-01 — #1132 reached LGTM after four adversarial review rounds closed run/journal identity gaps, stale criteria and merge authorization, reviewer filesystem leakage, crash convergence, live shadow wiring, and fd-based TOCTOU reads. #1133 reached LGTM with all seven dispatch executors retained, descriptor-driven capability checks, fail-closed live canary exits, and reproducible raw canary evidence.
- 2026-08-01 — #1134 reached LGTM after deleting 43 production scripts and their installed policy surfaces: routing/catalog precedence, assurance/advisory lanes, mutable fleet state, runtime analytics, and central CLI-schema indirection. Final production residue search was empty, all seven executors remained registered, and inventory/ledger/reachability passed 23/23. Cross-model review found and closed run.json/facts fail-open paths, fleet redispatch and publication gaps, an admission-generation ABA race, parent-symlink escape, and partial issue-lock publication poisoning; the final independent rereview passed 79 focused checks.
- 2026-08-03 — Deleted the migration overlay (`runtime-generation.js`, `legacy-recovery-shim.js`, their tests and fixtures; about −4,300 lines, runtime 8,262 → 6,039 LOC across 18 → 16 files). Decided on measurement, not cost: every path to a dispatchable vNext marker required an external Ed25519 attestation whose file and every parent directory up to `/` had to be owned by a different UID and be non-writable by the operator, which on a single-operator machine is satisfiable only by becoming root and signing to yourself. The overlay was blocking dispatch outright. Earlier the same day a narrower 766-line deletion of the overlay's retirement-gate layer was refuted by four independent reviewers and reverted in full; that lesson is recorded in `docs/decisions/2026-08-03-migration-overlay-disposition.md`. The repository-wide generation lock was replaced by a non-recursive `mkdir` claim on the run directory.
