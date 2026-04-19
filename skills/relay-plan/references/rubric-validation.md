# Rubric Validation, Grading, and Quality Card

This reference holds the step-3 validation detail that used to live inline in `SKILL.md`. Apply it between `## 2. Build the rubric` and `## 4. Generate dispatch prompt`.

## Validate the rubric (full checklist)

Before dispatch, verify:

- [ ] Prerequisites gate: automated checks for repo-wide hygiene (if any) are in `prerequisites`, not `factors`
- [ ] No hygiene in factors: every factor passes the tier test ("would this fail for a different task in this repo?" — if no, it's hygiene)
- [ ] Contract minimum met: ≥ {size-based min} contract-tier factors
- [ ] Quality minimum met: ≥ {size-based min} quality-tier factors
- [ ] ≥ 1 automated check exists across prerequisites + factors
- [ ] All automated check commands are immutable (executor cannot modify)
- [ ] Every evaluated factor has `scoring_guide` with low/mid/high anchors
- [ ] Criteria are specific ("timeouts on external calls") not vague ("good error handling")
- [ ] Criteria reference discoverable artifacts (file paths, function names, code patterns with examples), not abstractions ("follows conventions"); if the executor would need to read 5+ files to understand the criterion, ground it or convert it to an automated check
- [ ] Targets are concrete ("≥ 8/10", "< 200ms") not relative ("good", "fast")
- [ ] Automated checks measure outcomes not proxies

## Factor count rules

Prerequisites (hygiene): as many as needed, uncounted. Factors (contract + quality): no hard cap, warning at 8+.

| Size | Contract min | Quality min | Substantive total | Recommended |
|------|--------------|-------------|-------------------|-------------|
| S (1-2 AC) | ≥ 1 | ≥ 1 | 2+ | ~3 |
| M (3-4 AC) | ≥ 2 | ≥ 1 | 3+ | ~5 |
| L (5-6 AC) | ≥ 2 | ≥ 2 | 4+ | ~6 |
| XL (7+ AC) | ≥ 3 | ≥ 2 | 5+ | ~8 |

## Rubric Quality Card

Summarize the rubric before dispatch so weak calibration is visible.

The `Probe signal` lines below are rendered from `probe-executor-env.js --project-only --json` and stay informational only (see `signals.md`).

```text
Synthetic populated signal example
---------------------------------
Prerequisites count: 2
Contract factors: 2
Quality factors: 2
Substantive total: 4
Quality ratio: 50%
Auto coverage: 3 / 6 checks automated across prerequisites + factors
Calibration status: skipped (S/M task)
Risk signals: none
Historical signal:
historical_signal.stuck_factors: Docs (met_rate=0.5, avg_rounds_to_met=3); Coverage (met_rate=0.6667, avg_rounds_to_met=1.5)
historical_signal.divergence_hotspots: Coverage (avg_delta=2.5, recommendation=Executor scores trend higher than review; tighten examples or add automation.); Docs (avg_delta=-2, recommendation=Reviewer scores trend higher than executor; check whether the factor is underspecified.)
historical_signal.avg_rounds: contract.avg_rounds_to_met=1.5; quality.avg_rounds_to_met=1; metrics.median_rounds_to_ready=3
Probe signal:
probe_signal.test_infra: jest
probe_signal.lint_format: eslint, prettier
probe_signal.type_check: typescript, tsc --noEmit
probe_signal.ci: GitHub Actions (ci.yml)
probe_signal.scripts: npm run lint, npm run test, npm run typecheck
Grade: A
Action: dispatch allowed

No-history + no-signal example
------------------------------
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

Fallback example
----------------
Prerequisites count: 2
Contract factors: 2
Quality factors: 2
Substantive total: 4
Quality ratio: 50%
Auto coverage: 3 / 6 checks automated across prerequisites + factors
Calibration status: skipped (S/M task)
Risk signals: none
Historical signal: Reliability report unavailable: Unexpected end of JSON input. Proceeding without historical signal.
historical_signal.stuck_factors: no historical data available
historical_signal.divergence_hotspots: no historical data available
historical_signal.avg_rounds: no historical data available
Probe signal: Probe signals unavailable: probe timed out after 30s. Proceeding without probe signal.
probe_signal.test_infra: no quality infra detected
probe_signal.lint_format: no quality infra detected
probe_signal.type_check: no quality infra detected
probe_signal.ci: no quality infra detected
probe_signal.scripts: no quality infra detected
Grade: A
Action: dispatch allowed
```

## Grading logic

Apply downgrade checks first (`D`, then `C`), then assign `A` or `B`.

| Grade | Criteria | Action |
|-------|----------|--------|
| **A** | Tier minimum met + quality ratio ≥ 40% + every evaluated factor has `scoring_guide` + criteria grounded to discoverable artifacts | Dispatch allowed |
| **B** | Tier minimum met + quality ratio ≥ 25% + every evaluated factor has `scoring_guide` | Dispatch allowed, but note weaker quality coverage |
| **C** | Tier minimum met, but quality is only at the exact size-based minimum OR exactly 1 evaluated factor is missing `scoring_guide` | Warning before dispatch |
| **D** | Any tier minimum violated OR hygiene check left in `factors` | Dispatch blocked, revise first |

Grade D means stop and revise the rubric first. Grade C means warn before dispatch and make the tradeoff explicit.

## Risk signals

| Signal | Trigger condition |
|--------|-------------------|
| `low_quality_ratio` | Quality ratio < 25% |
| `no_automated_factor` | Zero automated checks across prerequisites + factors |
| `ungrounded_criteria` | Criteria refer to abstractions instead of discoverable artifacts |
| `vague_criteria` | Criteria contain "good", "proper", "clean", or "appropriate" |
| `proxy_metric` | Automated checks measure effort or process instead of outcome |
| `high_factor_count` | 8+ substantive factors |
| `all_contract` | Zero quality coverage beyond the size-based minimum |

Any check fails → revise. See `rubric-design-guide.md` for fix patterns.
