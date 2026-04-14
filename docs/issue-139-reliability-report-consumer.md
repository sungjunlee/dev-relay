# Issue 139 Reliability Report Consumer

## Summary

#139 closes Phase 0.2 of `/Users/sjlee/workspace/active/harness-stack/dev-relay/docs/agentic-patterns-adoption.md` by making [`skills/relay-plan/SKILL.md`](../skills/relay-plan/SKILL.md) consume `reliability-report.js --json` before rubric design, surface historical signal inside the Rubric Quality Card, and document a named fallback when the producer is unavailable. The change is informational only per AC5: the rubric structure, grade rules, and dispatch eligibility remain unchanged.

## Pattern-Break Rationale

This PR is not another rung in the `#149 -> #177` resolver-hardening ladder. It is the Phase 0.2 planner consumer that the design source already called for once the Batch 1.5 chain was clean.

The post-merge challenge scope here is narrowed to #139's own invariants:

1. Consumption reachability: `relay-plan/SKILL.md` runs `reliability-report.js --json` before rubric design.
2. Fallback reachability: empty history, malformed stored data, and generic non-zero exits are all distinguishable.
3. Scope containment: no new report consumer is added outside `relay-plan`.
4. AC5 informational-only discipline: historical signal informs calibration only; it does not change rubric structure, grading, or dispatch eligibility.

No sibling-axis probes from the #177 resolver challenge apply here. The review-bundle gap remains the same as #174/#177: relay-review does not read the PR body, so the evidence for #139 lives in this tracked mirror instead.

## Rules Applied

Rules 3, 6, and 7 are directly load-bearing on this PR. Rules 1 and 4 are indirectly load-bearing through AC5's informational-only guard. Rules 2 and 5 were consulted to keep the consumer bounded to the frozen producer shape and adjacent-path audit.

| Rule | Summary form | Application in #139 |
| --- | --- | --- |
| 1. Enforcement-layer tagging | Separate visible guidance from enforcement/gating. | Indirectly load-bearing: the new `relay-plan` step and Quality Card text are visible planner guidance only; they do not alter grade or dispatch eligibility. |
| 2. Trust-root companion factors | When a value is a trust root, keep its companion assumptions explicit. | Consulted: the consumer reads only the frozen `5362fc3` producer fields and does not invent alternate sources or inferred schema. |
| 3. Sibling-field enumeration + end-to-end recovery-test extension | Enumerate sibling inputs and test the full documented recovery path. | Directly load-bearing: the consumer explicitly enumerates `factor_analysis`, `rubric_insights`, and `metrics` siblings and adds end-to-end tests for empty history, malformed data, and generic non-zero exit recovery. |
| 4. State-machine-axis whitelist | Treat stateful enforcement as a whitelist, not a silent catch-all. | Indirectly load-bearing: historical signal is kept off the dispatch/state axis entirely, which is the AC5 safety boundary for this PR. |
| 5. Selector-composition axis enumeration | Audit adjacent selectors/consumers that feed the same outcome. | Consulted: the audit delta explicitly checks adjacent planner/dispatch/review/merge paths and keeps new consumption isolated to `relay-plan`. |
| 6. Call-site extension meta-rule | Audit every call site of the affected behavior, not just the one that surfaced the gap. | Directly load-bearing: the report is consumed at both planner call sites that matter here, the pre-rubric read step and the Rubric Quality Card rendering contract. |
| 7. Fail-closed state-validation meta-rule | Error paths must validate and name the failure cause rather than fail open. | Directly load-bearing: producer failure is rendered as `Reliability report unavailable: <cause>. Proceeding without historical signal.` with the first stderr line or exit code surfaced. |

## Consumer Audit Delta

| Path | Status | Delta under #139 |
| --- | --- | --- |
| `skills/relay-plan/SKILL.md` | **MODIFIED** | Adds `### 1.5 Read historical signal` at lines 26-50 and adds the `Historical signal` subsection plus examples inside the Quality Card section at lines 167-222. |
| `skills/relay-plan/scripts/reliability-report-consumer.js` | **ADDED** | Planner-side consumer helper that reads the producer best-effort and renders the documented fallback contract without touching the producer. |
| `skills/relay-plan/scripts/reliability-report-consumer.test.js` | **ADDED** | Three separate regression tests covering empty history, malformed stored data, and generic non-zero producer failure. |
| `skills/relay-dispatch/SKILL.md` | **UNCHANGED** | No new consumer logic added. The self-review grep still shows one pre-existing operator-command reference at line 148; this PR does not modify it. |
| `skills/relay-review/scripts/review-runner.js` | **UNCHANGED** | Review does not consume reliability-report; the PR-body visibility gap is handled by this mirror doc. |
| `skills/relay-merge/scripts/finalize-run.js` | **UNCHANGED** | Merge flow remains independent of reliability-report. |
| `skills/relay-dispatch/scripts/reliability-report.js` | **UNCHANGED** | Producer shape frozen on `5362fc3`; this PR consumes the current return contract only. |

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
- `#140` - deferred; tracked in `#140`.

## Self-Review Grep

```text
$ grep -rn "reliability-report" skills/relay-dispatch/SKILL.md skills/relay-review/SKILL.md skills/relay-merge/SKILL.md skills/relay-intake/SKILL.md skills/relay/SKILL.md
skills/relay-dispatch/SKILL.md:148:${CLAUDE_SKILL_DIR}/scripts/reliability-report.js --repo . --json

$ grep -n "reliability-report" skills/relay-plan/SKILL.md
31:node ${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/reliability-report.js --repo . --json
34:informational only: use this `reliability-report.js` input to tighten factor wording, calibration examples, and review guidance, but keep the existing rubric structure, grading logic, and dispatch eligibility unchanged.

$ grep -n "historical_signal\." skills/relay-plan/SKILL.md
40:| `historical_signal.stuck_factors` | `factor_analysis.most_stuck_factor` plus every factor where `met_rate < 1.0` or `avg_rounds_to_met >= 3` | Surface factors that historically stall so the rubric names the weak spot directly |
41:| `historical_signal.divergence_hotspots` | `rubric_insights.divergence_hotspots` (top 3 by `occurrences`, carrying `factor_pattern`, `avg_delta`, and `recommendation` verbatim) | Surface disagreement hotspots so the rubric tightens examples or adds automation where useful |
42:| `historical_signal.avg_rounds` | `rubric_insights.tier_effectiveness.contract.avg_rounds_to_met`, `rubric_insights.tier_effectiveness.quality.avg_rounds_to_met`, and `metrics.median_rounds_to_ready` | Calibrate how sharp the contract vs quality checks need to be |
48:| No prior runs / empty history | `Empty-data state — historical signal not available, proceed to rubric design.` Render each `historical_signal.*` field as `no historical data available`. |
49:| Malformed manifest or event data | `Reliability report unavailable: <cause>. Proceeding without historical signal.` Use the first stderr line as `<cause>` and still render each `historical_signal.*` field as `no historical data available`. |
183:historical_signal.stuck_factors: Docs (met_rate=0.5, avg_rounds_to_met=3); Coverage (met_rate=0.6667, avg_rounds_to_met=1.5)
184:historical_signal.divergence_hotspots: Coverage (avg_delta=2.5, recommendation=Executor scores trend higher than review; tighten examples or add automation.); Docs (avg_delta=-2, recommendation=Reviewer scores trend higher than executor; check whether the factor is underspecified.)
185:historical_signal.avg_rounds: contract.avg_rounds_to_met=1.5; quality.avg_rounds_to_met=1; metrics.median_rounds_to_ready=3
200:historical_signal.stuck_factors: no historical data available
201:historical_signal.divergence_hotspots: no historical data available
202:historical_signal.avg_rounds: no historical data available
217:historical_signal.stuck_factors: no historical data available
218:historical_signal.divergence_hotspots: no historical data available
219:historical_signal.avg_rounds: no historical data available

$ grep -n "informational only" skills/relay-plan/SKILL.md
34:informational only: use this `reliability-report.js` input to tighten factor wording, calibration examples, and review guidance, but keep the existing rubric structure, grading logic, and dispatch eligibility unchanged.

$ grep -nE "(reject|block|fail|abort|gate).*(most_stuck|divergence|historical_signal|reliability.report)" skills/relay-plan/SKILL.md

$ grep -n "Rubric Quality Card" skills/relay-plan/SKILL.md
167:### Rubric Quality Card
```

The first grep is not empty because `skills/relay-dispatch/SKILL.md:148` already contained a pre-existing operator command reference to `reliability-report.js` before #139. That line is unchanged by this PR and is captured here so the mirror stays truthful.

## Rendered Examples

Relay run storage is keyed by absolute repo root. The isolated `issue-139` worktree therefore has no attached run history of its own, while the canonical repo root `/Users/sjlee/workspace/active/harness-stack/dev-relay` retains the populated run history used below. The card scaffold mirrors the `relay-plan` example; the `Historical signal` subsection is rendered from the named data source in each case.

**Populated - live canonical repo data captured 2026-04-14 from `/Users/sjlee/workspace/active/harness-stack/dev-relay` on branch `main`**

```text
Prerequisites count: 2
Contract factors: 2
Quality factors: 2
Substantive total: 4
Quality ratio: 50%
Auto coverage: 3 / 6 checks automated across prerequisites + factors
Calibration status: skipped (S/M task)
Risk signals: none
Historical signal:
historical_signal.stuck_factors: [consumer audit — standalone --pr consumers, sibling-field + call-site extension meta-rules] PR body enumerates every consumer of resolveManifestRecord and names the delta under the #174 predicate (met_rate=1, avg_rounds_to_met=5); [consumer audit + happy-path preservation + sibling enumeration] PR body enumerates every rubricLoad/rubricAnchor consumer and each state × layer decision (met_rate=1, avg_rounds_to_met=3); [end-to-end reachability test per recovery message, anti-theater] Every error path in resolveManifestRecord's no-match tree has a test that exercises the named recovery command (met_rate=1, avg_rounds_to_met=5); [end-to-end recovery + operator communication] Full recovery flow has an executable test; error messages name the recovery path (met_rate=1, avg_rounds_to_met=4); [per-scenario anti-theater tests] Three regression tests cover the bypass; each fails against pre-fix code (met_rate=1, avg_rounds_to_met=3); [quality, consumer audit — includeTerminal preservation is the centerpiece] Every resolveManifestRecord consumer enumerated; finalize-run --skip-merge --pr verified unaffected (met_rate=1, avg_rounds_to_met=3); Enforcement errors are actionable and distinguishable (met_rate=1, avg_rounds_to_met=6); Event model quality and portability (met_rate=1, avg_rounds_to_met=4); Existing test suites unbroken (met_rate=0); gate-check rejects merge when anchor.rubric_path is absent (met_rate=1, avg_rounds_to_met=3); Grandfather path allows pre-change runs to merge without rubric_path (met_rate=1, avg_rounds_to_met=4); Grandfathering strategy is safe, explicit, and time-bound (met_rate=1, avg_rounds_to_met=6); Regression test coverage is complete and hermetic (met_rate=1, avg_rounds_to_met=4); Scenario test design quality (met_rate=1, avg_rounds_to_met=3); Scenario tests cover the required intake flows (met_rate=0)
historical_signal.divergence_hotspots: no historical data available
historical_signal.avg_rounds: contract.avg_rounds_to_met=1.48; quality.avg_rounds_to_met=2.7917; metrics.median_rounds_to_ready=3
Grade: A
Action: dispatch allowed
```

**No-history - isolated worktree data captured 2026-04-14 from `/Users/sjlee/.relay/worktrees/0acd9622/dev-relay` on branch `issue-139`**

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
Grade: A
Action: dispatch allowed
```

**Fallback - malformed-manifest fixture with first-stderr-line cause**

```text
Prerequisites count: 2
Contract factors: 2
Quality factors: 2
Substantive total: 4
Quality ratio: 50%
Auto coverage: 3 / 6 checks automated across prerequisites + factors
Calibration status: skipped (S/M task)
Risk signals: none
Historical signal: Reliability report unavailable: Invalid manifest entry on line 2. Proceeding without historical signal.
historical_signal.stuck_factors: no historical data available
historical_signal.divergence_hotspots: no historical data available
historical_signal.avg_rounds: no historical data available
Grade: A
Action: dispatch allowed
```

## Cross-Links

- Phase 0.2 design source: `/Users/sjlee/workspace/active/harness-stack/dev-relay/docs/agentic-patterns-adoption.md:68-76` on `5362fc3`.
- Sprint progress anchor: `/Users/sjlee/workspace/active/harness-stack/dev-relay/backlog/sprints/2026-04-agentic-patterns-phase-0.md`, Progress entry `2026-04-14 13:40`.
