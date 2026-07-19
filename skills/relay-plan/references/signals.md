# Planner Input Signals

Planner input signals feed into rubric design during `relay-plan` steps 2 and 3. They are read-only inputs; none gates dispatch, alters state transitions, or modifies rubric structure by itself. They inform factor wording, prerequisite naming, where to look, and Available Tools context only.

## Signal authority hierarchy

Use this order when inputs disagree:

1. Frozen Done Criteria once persisted or otherwise selected as the review anchor.
2. Explicit issue/task AC and relay-ready handoff while recovering Done Criteria.
3. Task-specific risk discovered during planning.
4. Project harness context, probe signal, historical signal, and optional subsystem scout notes.

The fourth group is weak planning context. It can suggest files, commands, terminology, and likely risk areas, but it cannot add product requirements, narrow explicit AC, or replace Done Criteria. If weak context appears to conflict with the task source, resolve the conflict before freezing Done Criteria and persist the planner-authored anchor when the final anchor differs from the task source.

## Project harness context

Task-relevant local harness/context files may include `AGENTS.md`, `CLAUDE.md`, `CHARTER.md`, `spec/capabilities.md`, and active sprint notes. Read them when they are present and plausibly relevant to the task, but treat them as execution and planning context unless the task explicitly names them as the product surface being changed.

Field mapping (planner-authored, no required producer):

| `harness_context.*` field | Read from | Planning use |
|---------------------------|-----------|--------------|
| `instructions` | Repo-local agent or contributor instructions such as `AGENTS.md` or `CLAUDE.md` | Preserve local workflow, style, and safety boundaries without treating them as product acceptance criteria |
| `charter` | `CHARTER.md`, product charter, or equivalent project intent document | Clarify terminology and user-facing intent when it helps recover observable Done Criteria |
| `capabilities` | `spec/capabilities.md` or equivalent capability map | Locate relevant subsystems and existing behavior contracts |
| `sprint_context` | Active sprint or backlog execution notes | Understand sequencing, dependencies, and nearby work; GitHub issues or relay-ready artifacts remain the source of truth for what to build |

Case handling:

| Case | Planner handling |
|------|------------------|
| Harness file absent | Proceed without harness context; do not create a placeholder artifact. |
| Harness file present but unrelated | Ignore it or mention it only as skipped context; do not let it broaden scope. |
| Harness context conflicts with explicit AC or relay-ready handoff | Treat the conflict as an ambiguity to resolve before freezing Done Criteria. |
| Task explicitly asks to edit a harness file | Treat that file as the task target for that change, while still keeping its general guidance non-authoritative over unrelated product requirements. |

## Historical signal — `reliability-report.js`

Command:

```bash
node skills/relay-dispatch/scripts/reliability-report.js --repo . --json
```

Field mapping (current producers):

| `historical_signal.*` field | Read from | Planning use |
|-----------------------------|-----------|--------------|
| `stuck_factors` | `factor_analysis.most_stuck_factor` plus every entry in `factor_analysis.factors` where `met_rate < 1.0` or `avg_rounds_to_met >= 3` | Surface factors that historically stall so the rubric names the weak spot directly |
| `avg_rounds` | `rubric_insights.tier_effectiveness.contract.avg_rounds_to_met`, `rubric_insights.tier_effectiveness.quality.avg_rounds_to_met`, and `metrics.median_rounds_to_ready` | Calibrate how sharp the contract vs quality checks need to be |
| `qualitative_signals` | `qualitative_signals` (single optional object summarizing fix_hint round-delta correlation when ≥3 runs have rubric data across both cohorts) | Use the round delta as a weak prior to interpret in light of the rubric draft, not as a directive. |

If the report returns valid JSON but there are no prior runs (`manifests: 0`, `events: 0`), treat that as empty history rather than an error.

Case handling:

| Case | Planner handling |
|------|------------------|
| No prior runs / empty history | `Empty-data state — historical signal not available, proceed to rubric design.` Render each `historical_signal.*` field as `no historical data available`. |
| Malformed manifest or event data | `Reliability report unavailable: <cause>. Proceeding without historical signal.` Use the first stderr line (with any leading `Error:` prefix stripped) as `<cause>` and still render each `historical_signal.*` field as `no historical data available`. |
| Any other non-zero exit (missing script, broken dependency, runtime error) | `Reliability report unavailable: <cause>. Proceeding without historical signal.` Surface the first stderr line (with any leading `Error:` prefix stripped) when present, otherwise the exit code, then continue rubric design. |

## Probe signal — `probe-executor-env.js`

Command:

```bash
node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json
```

The planner picks what fits the task; the signal does not pick for them. No autonomy scoring, no auto-calibration of rubric depth — data exposure only.

Field mapping (current producers):

| `probe_signal.*` field | Read from | Planning use |
|------------------------|-----------|--------------|
| `test_infra` | `project_tools.frameworks` filtered to test runners (`jest`, `vitest`, `mocha`, `playwright`, `@playwright/test`, `cypress`, `pytest`) | Use the detected runner to inform a prerequisite or automated factor when it fits the task; the signal informs the choice, it does not require one |
| `lint_format` | `project_tools.frameworks` filtered to linters/formatters (`eslint`, `prettier`, `ruff`, `black`, `isort`, `pylint`) | Reuse the detected hygiene tool in prerequisites when that keeps the rubric grounded to repo-native checks |
| `type_check` | `project_tools.frameworks` filtered to type checkers (`typescript`, `mypy`) plus `project_tools.scripts` commands containing `tsc --noEmit` or `mypy` | Prefer an existing type-check command such as `tsc --noEmit` or `mypy --strict` when it matches the task and repo conventions |
| `ci` | `project_tools.ci` from `.github/workflows/*.yml` and `.github/workflows/*.yaml` | Reference detected CI workflows in the dispatch prompt's Available Tools context when that helps explain what automation already exists |
| `scripts` | `project_tools.scripts` (top 5 by name order) | Pick an existing script as the prerequisite command rather than inventing a new one when the repo already exposes the right check |

Optional additional fields such as `probe_signal.bundlers`, `probe_signal.a11y`, `probe_signal.bundle_size`, or `probe_signal.security` may be surfaced when present. Omit them when absent; the baseline five fields above stay fixed.

Case handling:

| Case | Planner handling |
|------|------------------|
| No signals detected | `Probe signal: no quality infra detected.` Render each `probe_signal.*` field as `no quality infra detected`. This is acceptable, not an error. |
| Probe failure / `agent_probe_error` present | `Probe signals unavailable: <cause>. Proceeding without probe signal.` Use the first stderr line (with any leading `Error:` prefix stripped), the `agent_probe_error` string, or the exit code as `<cause>`, then continue rubric design. |
| Malformed JSON on stdout | `Probe signals unavailable: <cause>. Proceeding without probe signal.` Surface the parse error and continue rubric design. |
