# Planner Input Signals

Two informational signals feed into rubric design during `relay-plan` steps 1.5 and 1.6. Both are read-only inputs; neither gates dispatch, alters state transitions, or modifies rubric structure. They inform factor wording, prerequisite naming, and Available Tools context only.

## Historical signal — `reliability-report.js`

Command:

```bash
node ${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/reliability-report.js --repo . --json
```

Field mapping (current producers):

| `historical_signal.*` field | Read from | Planning use |
|-----------------------------|-----------|--------------|
| `stuck_factors` | `factor_analysis.most_stuck_factor` plus every entry in `factor_analysis.factors` where `met_rate < 1.0` or `avg_rounds_to_met >= 3` | Surface factors that historically stall so the rubric names the weak spot directly |
| `divergence_hotspots` | `rubric_insights.divergence_hotspots` (top 3 by `occurrences`, carrying `factor_pattern`, `avg_delta`, and `recommendation` verbatim) | Surface executor/reviewer disagreement hotspots so the rubric tightens examples or adds automation |
| `avg_rounds` | `rubric_insights.tier_effectiveness.contract.avg_rounds_to_met`, `rubric_insights.tier_effectiveness.quality.avg_rounds_to_met`, and `metrics.median_rounds_to_ready` | Calibrate how sharp the contract vs quality checks need to be |

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
node ${CLAUDE_SKILL_DIR}/scripts/probe-executor-env.js . --project-only --json
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
