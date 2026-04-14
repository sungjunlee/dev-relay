# Issue 140 Probe Signal Consumer

## Summary

#140 closes Phase 0.3 of `/Users/sjlee/workspace/active/harness-stack/dev-relay/docs/agentic-patterns-adoption.md` by making [`skills/relay-plan/SKILL.md`](../skills/relay-plan/SKILL.md) consume `probe-executor-env.js --project-only --json` before rubric design, surface detected quality signals inside the Rubric Quality Card, and document named empty/fallback handling without changing rubric grading or dispatch behavior. Data exposure only per AC4. This PR closes Phase 0 ("Wire What Exists") — after merge, all three Phase 0 issues (`#148/#139/#140`) have landed.

## Pattern-Break Rationale

This PR is the Phase 0.3 planner consumer. It is not another rung in the `#149 -> #177` resolver-hardening ladder and it is not a sibling-axis follow-up to a prior fail-closed bypass.

The post-merge challenge scope here is narrowed to #140's own invariants:

1. Consumption reachability: `relay-plan/SKILL.md` reads `probe-executor-env.js . --project-only --json` before rubric design.
2. Fallback reachability: no-signal, surfaced-cause fallback, and generic non-zero failure are all distinguishable.
3. Scope containment: probe-signal consumption stays inside `relay-plan`.
4. AC4 data-exposure-only discipline: probe signals inform prerequisites/examples only; they do not change rubric structure, grading, dispatch eligibility, or autonomy scoring.

No sibling-axis probes from the resolver ladder apply. The review-bundle visibility gap is the same as #139: relay-review does not read the PR body, so the evidence for #140 lives in this tracked mirror.

## Rules Applied

Rules 3, 6, and 7 are directly load-bearing on this PR. Rules 1 and 4 are indirectly load-bearing through AC4's data-exposure-only guard. Rules 2 and 5 were consulted to keep the consumer bounded to the current probe contract and adjacent-path audit.

| Rule | Summary form | Application in #140 |
| --- | --- | --- |
| 1. Enforcement-layer tagging | Separate visible guidance from enforcement/gating. | Indirectly load-bearing: `probe_signal.*` is exposed in planner guidance only and explicitly does not gate dispatch, alter state transitions, or modify rubric structure. |
| 2. Trust-root companion factors | When a value is a trust root, keep its companion assumptions explicit. | Consulted: the consumer reads only the documented `project_tools.*` probe output and adds the `project_tools.ci` sibling additively instead of inventing alternate sources. |
| 3. Sibling-field enumeration + end-to-end recovery-test extension | Enumerate sibling inputs and test the full documented recovery path. | Directly load-bearing: the consumer enumerates `project_tools.frameworks`, `project_tools.scripts`, and `project_tools.ci`, and the regression tests cover empty data, surfaced-cause fallback, and generic non-zero failure. |
| 4. State-machine-axis whitelist | Treat stateful enforcement as a whitelist, not a silent catch-all. | Indirectly load-bearing: probe signals stay off the state-machine axis entirely, which is the AC4 safety boundary for this PR. |
| 5. Selector-composition axis enumeration | Audit adjacent selectors/consumers that feed the same outcome. | Consulted: the audit delta explicitly checks adjacent planner/dispatch/review/merge paths and keeps new consumption isolated to `relay-plan`. |
| 6. Call-site extension meta-rule | Audit every call site of the affected behavior, not just the one that surfaced the gap. | Directly load-bearing: the probe is consumed at both planner call sites that matter here, the pre-rubric read step and the Rubric Quality Card rendering contract. |
| 7. Fail-closed state-validation meta-rule | Error paths must validate and name the failure cause rather than fail open. | Directly load-bearing: probe failure renders `Probe signals unavailable: <cause>. Proceeding without probe signal.` with the surfaced cause preserved. |

## Consumer Audit Delta

| Path | Status | Delta under #140 |
| --- | --- | --- |
| `skills/relay-plan/SKILL.md` | **MODIFIED** | Adds `### 1.6 Read probe quality signals` at lines 52-78 and adds the `Probe signal` subsection inside the Quality Card examples at lines 195-269. |
| `skills/relay-plan/scripts/probe-executor-env-consumer.js` | **ADDED** | Planner-side consumer helper that reads the project-only probe, derives the five `probe_signal.*` fields, and renders the named fallback contract without blocking dispatch. |
| `skills/relay-plan/scripts/probe-executor-env-consumer.test.js` | **ADDED** | Three separate regression tests covering no-signal, surfaced-cause fallback, and generic non-zero failure. |
| `skills/relay-plan/scripts/probe-executor-env.js` | **MODIFIED** | Adds additive `project_tools.ci` detection from `.github/workflows/*.yml|*.yaml`; existing `scripts` / `frameworks` producer fields stay unchanged. |
| `skills/relay-plan/scripts/probe-executor-env.test.js` | **MODIFIED** | Adds CI workflow detection coverage and updates empty-shape expectations to include `ci: []`. |
| `skills/relay-dispatch/SKILL.md` | **UNCHANGED** | No new probe consumer logic added. The required cross-skill grep for `probe-executor-env` is empty. |
| `skills/relay-review/scripts/review-runner.js` | **UNCHANGED** | Review still does not consume probe signals; the evidence lives in this mirror doc. |
| `skills/relay-merge/scripts/finalize-run.js` | **UNCHANGED** | Merge flow remains independent of probe-signal consumption. |

## Probe-Extension Choice

Path X was taken. `skills/relay-plan/scripts/probe-executor-env.js` now scans `.github/workflows/*.yml` and `.github/workflows/*.yaml` into `project_tools.ci`, which lets the Quality Card render the literal AC2 example shape (`probe_signal.ci: GitHub Actions (...)`) without deferring a repo-local signal that was already cheap to expose. The change is additive only: `project_tools.scripts` and `project_tools.frameworks` are unchanged, and the planner consumer still treats every detected signal as informational only.

## Deferred-Issue Inventory

- `#176` - deferred; tracked in `#176`.
- `#166` - deferred; tracked in `#166`.
- `#163` - deferred; tracked in `#163`.
- `#160` - deferred; tracked in `#160`.
- `#161` - deferred; tracked in `#161`.
- `#158` - deferred; tracked in `#158`.
- `#151` - deferred; tracked in `#151`.
- `#150` - deferred; tracked in `#150`.
- `#152` - deferred; tracked in `#152`.
- `#153` - deferred; tracked in `#153`.

## Self-Review Grep

```text
$ grep -n "probe-executor-env" skills/relay-plan/SKILL.md
57:node ${CLAUDE_SKILL_DIR}/scripts/probe-executor-env.js . --project-only --json
199:The `Probe signal` lines below are rendered from `probe-executor-env.js --project-only --json` and stay informational only.

$ grep -n "probe_signal\." skills/relay-plan/SKILL.md
60:**Informational only:** the `probe_signal.*` output does not gate dispatch, does not alter state transitions, and does not modify rubric structure. Use the signal to inform rubric design, prerequisite naming, and Available Tools context; the planner picks what fits the task, the signal does not pick for them. No autonomy scoring, no auto-calibration of rubric depth — data exposure only.
66:| `probe_signal.test_infra` | `project_tools.frameworks` filtered to test runners (`jest`, `vitest`, `mocha`, `playwright`, `@playwright/test`, `cypress`, `pytest`) | Use the detected runner to inform a prerequisite or automated factor when it fits the task; the signal informs the choice, it does not require one |
67:| `probe_signal.lint_format` | `project_tools.frameworks` filtered to linters/formatters (`eslint`, `prettier`, `ruff`, `black`, `isort`, `pylint`) | Reuse the detected hygiene tool in prerequisites when that keeps the rubric grounded to repo-native checks |
68:| `probe_signal.type_check` | `project_tools.frameworks` filtered to type checkers (`typescript`, `mypy`) plus `project_tools.scripts` commands containing `tsc --noEmit` or `mypy` | Prefer an existing type-check command such as `tsc --noEmit` or `mypy --strict` when it matches the task and repo conventions |
69:| `probe_signal.ci` | `project_tools.ci` from `.github/workflows/*.yml` and `.github/workflows/*.yaml` | Reference detected CI workflows in the dispatch prompt's Available Tools context when that helps explain what automation already exists |
70:| `probe_signal.scripts` | `project_tools.scripts` (top 5 by name order) | Pick an existing script as the prerequisite command rather than inventing a new one when the repo already exposes the right check |
72:Optional additional fields such as `probe_signal.bundlers`, `probe_signal.a11y`, `probe_signal.bundle_size`, or `probe_signal.security` may be surfaced when present. Omit them when absent; the baseline five fields above stay fixed.
76:| No signals detected | `Probe signal: no quality infra detected.` Render each `probe_signal.*` field as `no quality infra detected`. This is acceptable, not an error. |
217:probe_signal.test_infra: jest
218:probe_signal.lint_format: eslint, prettier
219:probe_signal.type_check: typescript, tsc --noEmit
220:probe_signal.ci: GitHub Actions (ci.yml)
221:probe_signal.scripts: npm run lint, npm run test, npm run typecheck
240:probe_signal.test_infra: no quality infra detected
241:probe_signal.lint_format: no quality infra detected
242:probe_signal.type_check: no quality infra detected
243:probe_signal.ci: no quality infra detected
244:probe_signal.scripts: no quality infra detected
263:probe_signal.test_infra: no quality infra detected
264:probe_signal.lint_format: no quality infra detected
265:probe_signal.type_check: no quality infra detected
266:probe_signal.ci: no quality infra detected
267:probe_signal.scripts: no quality infra detected

$ grep -n "does not gate dispatch" skills/relay-plan/SKILL.md
34:**Informational only:** the `historical_signal.*` output does not gate dispatch, does not alter state transitions, and does not modify rubric structure. Use this `reliability-report.js` input to tighten factor wording, calibration examples, and review guidance; the existing rubric structure, grading logic, and dispatch eligibility are unchanged.
60:**Informational only:** the `probe_signal.*` output does not gate dispatch, does not alter state transitions, and does not modify rubric structure. Use the signal to inform rubric design, prerequisite naming, and Available Tools context; the planner picks what fits the task, the signal does not pick for them. No autonomy scoring, no auto-calibration of rubric depth — data exposure only.

$ grep -n "does not alter state transitions" skills/relay-plan/SKILL.md
34:**Informational only:** the `historical_signal.*` output does not gate dispatch, does not alter state transitions, and does not modify rubric structure. Use this `reliability-report.js` input to tighten factor wording, calibration examples, and review guidance; the existing rubric structure, grading logic, and dispatch eligibility are unchanged.
60:**Informational only:** the `probe_signal.*` output does not gate dispatch, does not alter state transitions, and does not modify rubric structure. Use the signal to inform rubric design, prerequisite naming, and Available Tools context; the planner picks what fits the task, the signal does not pick for them. No autonomy scoring, no auto-calibration of rubric depth — data exposure only.

$ grep -n "does not modify rubric structure" skills/relay-plan/SKILL.md
34:**Informational only:** the `historical_signal.*` output does not gate dispatch, does not alter state transitions, and does not modify rubric structure. Use this `reliability-report.js` input to tighten factor wording, calibration examples, and review guidance; the existing rubric structure, grading logic, and dispatch eligibility are unchanged.
60:**Informational only:** the `probe_signal.*` output does not gate dispatch, does not alter state transitions, and does not modify rubric structure. Use the signal to inform rubric design, prerequisite naming, and Available Tools context; the planner picks what fits the task, the signal does not pick for them. No autonomy scoring, no auto-calibration of rubric depth — data exposure only.

$ grep -nE "(autonomy|auto-?calibrate)" skills/relay-plan/SKILL.md
60:**Informational only:** the `probe_signal.*` output does not gate dispatch, does not alter state transitions, and does not modify rubric structure. Use the signal to inform rubric design, prerequisite naming, and Available Tools context; the planner picks what fits the task, the signal does not pick for them. No autonomy scoring, no auto-calibration of rubric depth — data exposure only.

$ grep -n "no quality infra detected" skills/relay-plan/SKILL.md
76:| No signals detected | `Probe signal: no quality infra detected.` Render each `probe_signal.*` field as `no quality infra detected`. This is acceptable, not an error. |
239:Probe signal: no quality infra detected.
240:probe_signal.test_infra: no quality infra detected
241:probe_signal.lint_format: no quality infra detected
242:probe_signal.type_check: no quality infra detected
243:probe_signal.ci: no quality infra detected
244:probe_signal.scripts: no quality infra detected
263:probe_signal.test_infra: no quality infra detected
264:probe_signal.lint_format: no quality infra detected
265:probe_signal.type_check: no quality infra detected
266:probe_signal.ci: no quality infra detected
267:probe_signal.scripts: no quality infra detected

$ grep -rn "probe-executor-env" skills/relay-dispatch/SKILL.md skills/relay-review/SKILL.md skills/relay-merge/SKILL.md skills/relay-intake/SKILL.md skills/relay/SKILL.md

$ grep -n "Rubric Quality Card" skills/relay-plan/SKILL.md
195:### Rubric Quality Card
```

## Rendered Examples

The Quality Card examples below use the same scaffold as `relay-plan/SKILL.md`. The historical section is empty-data in both cases because neither the synthetic fixture repo nor this isolated PR worktree carries prior relay run history under `RELAY_HOME`; the probe section is the axis under test for #140.

**Example A — Synthetic fixture — dev-relay itself has no scripts / frameworks / CI; this rendering demonstrates the populated form against a simulated Node.js repo.**

```text
Prerequisites count: 2
Contract factors: 2
Quality factors: 2
Substantive total: 4
Quality ratio: 50%
Auto coverage: 3 / 6 checks automated across prerequisites + factors
Calibration status: skipped (S/M task)
Risk signals: none
Historical signal: Empty-data state — historical signal not available, proceed to rubric design.
historical_signal.stuck_factors: no historical data available
historical_signal.divergence_hotspots: no historical data available
historical_signal.avg_rounds: no historical data available
Probe signal:
probe_signal.test_infra: jest
probe_signal.lint_format: eslint, prettier
probe_signal.type_check: typescript, tsc --noEmit
probe_signal.ci: GitHub Actions (ci.yml)
probe_signal.scripts: npm run lint, npm run test, npm run typecheck
Grade: A
Action: dispatch allowed
```

**Example B — Live no-signals render from `node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json` on the PR branch.**

```text
Prerequisites count: 2
Contract factors: 2
Quality factors: 2
Substantive total: 4
Quality ratio: 50%
Auto coverage: 3 / 6 checks automated across prerequisites + factors
Calibration status: skipped (S/M task)
Risk signals: none
Historical signal: Empty-data state — historical signal not available, proceed to rubric design.
historical_signal.stuck_factors: no historical data available
historical_signal.divergence_hotspots: no historical data available
historical_signal.avg_rounds: no historical data available
Probe signal: no quality infra detected.
probe_signal.test_infra: no quality infra detected
probe_signal.lint_format: no quality infra detected
probe_signal.type_check: no quality infra detected
probe_signal.ci: no quality infra detected
probe_signal.scripts: no quality infra detected
Grade: A
Action: dispatch allowed
```

## Phase 0 Completion Framing

Phase 0 ("Wire What Exists") is complete after #140 merges. No Phase 0 residual consumer work remains. Phase 1 (TDD mode, rejection log) is tracked under a separate milestone and is NOT a Phase 0 follow-up.

## Cross-Links

- Phase 0.3 design source: `/Users/sjlee/workspace/active/harness-stack/dev-relay/docs/agentic-patterns-adoption.md:79-86`.
- Sprint progress anchor: `/Users/sjlee/workspace/active/harness-stack/dev-relay/backlog/sprints/2026-04-agentic-patterns-phase-0.md:37`.
