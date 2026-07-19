# Rubric Validation, Grading, and Quality Card

This reference holds validation detail for both structured evaluation artifacts and
legacy rubrics. For `evaluation.schema_version: 2`, first apply
`evaluation-channels.md`: validate frozen Done Criteria as the Outcome Contract, place
binary evidence under Verification, and allow `earned_rubric.factors: []`. Factor
minimums, `prerequisites`, and contract-tier factor rules below are legacy-only during
the transition.

## Validate Structured Evaluation Channels

- [ ] Outcome Contract points to frozen, observable Done Criteria and explicit non-goals
- [ ] Verification contains concrete command, observation, or artifact evidence
- [ ] Tests, builds, type checks, lint, and artifact existence are not Earned Rubric factors
- [ ] Earned Rubric is optional; zero factors is a valid result
- [ ] No lower-authority channel expands or waives the Outcome Contract

## Validate a Legacy Rubric (full checklist)

Before dispatch, verify:

- [ ] Prerequisites gate: automated checks for repo-wide hygiene (if any) are in `prerequisites`, not `factors`
- [ ] No hygiene in factors: every factor passes the tier test ("would this fail for a different task in this repo?" — if no, it's hygiene)
- [ ] Contract minimum met: ≥ {size-based min} contract-tier factors
- [ ] Quality minimum met when the task has real design judgment; S-size mechanical tasks may have zero quality factors
- [ ] ≥ 1 automated check exists across prerequisites + factors
- [ ] All automated check commands are immutable (executor cannot modify)
- [ ] Every evaluated factor has `scoring_guide` with low/mid/high anchors
- [ ] Criteria are specific ("timeouts on external calls") not vague ("good error handling")
- [ ] Criteria reference discoverable artifacts (file paths, function names, code patterns with examples), not abstractions ("follows conventions"); if the executor would need to read 5+ files to understand the criterion, ground it or convert it to an automated check
- [ ] Targets are concrete ("≥ 8/10", "< 200ms") not relative ("good", "fast")
- [ ] Automated checks measure outcomes not proxies

## Validate Done Criteria (full checklist)

Before validating factor counts, verify the Done Criteria anchor itself:

- [ ] Observable outcomes: each item describes a result a reviewer can inspect, run, or experience
- [ ] Scope boundary: the anchor names what should change and, when useful, what should not change
- [ ] Reviewability: each item maps to a file, command, user flow, API shape, event, or explicit inspection path
- [ ] Risk coverage: trust boundaries, data loss, migrations, performance, UX failure states, and operational failure modes are either covered or explicitly out of scope
- [ ] Verification path: at least one automated check or evaluated inspection path exists for the task

If any Done Criteria check fails, revise or persist clearer planner-authored Done Criteria before dispatch.

## Factor count rules

Prerequisites (hygiene): as many as needed, uncounted. Factors (contract + quality): no hard cap, warning at 8+.

Ready-light is stricter because its purpose is keeping small tasks small. Ready-light S mechanical rubrics default to 1-2 substantive factors. More than 2 substantive factors must warn or block unless an explicit risk or design-bearing rationale is present. Repo-wide lint, typecheck, and test commands stay in prerequisites and do not count as task-specific factors. Unsupported helper, dependency, config, or abstraction requirements are over-engineering risk unless the Done Criteria explicitly require them.

| Size | Contract min | Quality min | Substantive total | Recommended |
|------|--------------|-------------|-------------------|-------------|
| S (narrow mechanical outcome, low ambiguity/risk) | ≥ 1 | 0 | 1+ | 1-2 |
| S (narrow design-bearing outcome) | ≥ 1 | ≥ 1 | 2+ | ~2 |
| M (standard feature or fix with moderate file scope) | ≥ 2 | ≥ 1 | 3+ | ~5 |
| L (cross-cutting, multi-file, ambiguous, or risk-bearing) | ≥ 2 | ≥ 2 | 4+ | ~6 |
| XL (architecture change, cross-domain, migration, or high-risk boundary) | ≥ 3 | ≥ 2 | 5+ | ~8 |

## Rubric Quality Card

Summarize the rubric before dispatch so weak calibration is visible.

The `Probe signal` lines below are rendered from `probe-executor-env.js --project-only --json` and stay informational only (see `signals.md`).

```text
S mechanical example
--------------------
Prerequisites count: 1
Contract factors: 1
Quality factors: 0
Substantive total: 1
Quality ratio: N/A (mechanical S-size task)
Auto coverage: 2 / 2 checks automated across prerequisites + factors
Hygiene-in-factor violations: none
TDD eligible factors: 1
TDD applied (tdd_anchor): 0
TDD skip reason: none declared (test infra available; planner did not opt in)
Calibration status: skipped (S task)
Risk signals: none
Rationale: Recovered Done Criteria require one observable behavior change; no design-bearing quality judgment was introduced.
Historical signal: no historical data available
Probe signal:
probe_signal.test_infra: node:test
TDD suggestion: decline (S-size mechanical task)
probe_signal.lint_format: no quality infra detected
probe_signal.type_check: no quality infra detected
probe_signal.ci: GitHub Actions (test.yml)
probe_signal.scripts: no quality infra detected
Grade: B
Action: dispatch allowed

Ready-light S mechanical compact example
----------------------------------------
Planning profile: ready_light
Prerequisites count: 1
Contract factors: 1
Quality factors: 0
Substantive total: 1
Quality ratio: N/A (ready-light S-size task)
Auto coverage: 1 / 2 checks automated across prerequisites + factors
Hygiene-in-factor violations: none
TDD eligible factors: 0
TDD applied (tdd_anchor): 0
TDD skip reason: docs_only
Calibration status: skipped (ready-light)
Risk signals: none
Rationale: Readiness already returned proceed, but no bypass anchor exists; this is a docs-only edit, so use one observable contract factor plus the smallest verification path.
Over-engineering check: Unsupported helper, dependency, config, or abstraction requirements are over-engineering risk.
Grade: B
Action: dispatch allowed

Ready-light S design-bearing example
------------------------------------
Planning profile: ready_light
Prerequisites count: 1
Contract factors: 1
Quality factors: 1
Substantive total: 2
Quality ratio: 50%
Auto coverage: 1 / 3 checks automated across prerequisites + factors
Hygiene-in-factor violations: none
TDD eligible factors: 0
TDD applied (tdd_anchor): 0
TDD skip reason: none declared
Calibration status: compact (ready-light design-bearing)
Risk signals: design-bearing
Design-bearing rationale: The task is still S-size, but user-visible copy or prompt wording can be correct in shape while poor in judgment, so one quality factor is justified.
Over-engineering check: no unsupported helper, dependency, config, or abstraction requirements.
Grade: B
Action: dispatch allowed

Synthetic populated signal example
---------------------------------
Prerequisites count: 2
Contract factors: 2
Quality factors: 2
Substantive total: 4
Quality ratio: 50%
Auto coverage: 3 / 6 checks automated across prerequisites + factors
Hygiene-in-factor violations: none
TDD eligible factors: 2
TDD applied (tdd_anchor): 1
TDD anchors: `tests/front-matter.test.js` via `jest` (Parser rejects malformed front matter)
Calibration status: skipped (S/M task)
Risk signals: none
Historical signal:
historical_signal.stuck_factors: Docs (met_rate=0.5, avg_rounds_to_met=3); Coverage (met_rate=0.6667, avg_rounds_to_met=1.5)
historical_signal.divergence_hotspots: Coverage (avg_delta=2.5, recommendation=Executor scores trend higher than review; tighten examples or add automation.); Docs (avg_delta=-2, recommendation=Reviewer scores trend higher than executor; check whether the factor is underspecified.)
historical_signal.avg_rounds: contract.avg_rounds_to_met=1.5; quality.avg_rounds_to_met=1; metrics.median_rounds_to_ready=3
Probe signal:
probe_signal.test_infra: jest
TDD suggestion: enable tdd_anchor on Parser rejects malformed front matter (probe runner: jest)
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
Hygiene-in-factor violations: none
TDD eligible factors: 2
TDD applied (tdd_anchor): 0
TDD skip reason: no_runner (auto-derived — probe reported no test infra)
Calibration status: skipped (S/M task)
Risk signals: none
Historical signal: Empty-data state — historical signal not available, proceed to rubric design.
historical_signal.stuck_factors: no historical data available
historical_signal.divergence_hotspots: no historical data available
historical_signal.avg_rounds: no historical data available
Probe signal: no quality infra detected.
probe_signal.test_infra: no quality infra detected
TDD suggestion: none (no_test_infra)
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
Hygiene-in-factor violations: none
TDD eligible factors: 2
TDD applied (tdd_anchor): 0
TDD skip reason: no_runner (auto-derived — probe unavailable, treated as no test infra)
Calibration status: skipped (S/M task)
Risk signals: none
Historical signal: Reliability report unavailable: Unexpected end of JSON input. Proceeding without historical signal.
historical_signal.stuck_factors: no historical data available
historical_signal.divergence_hotspots: no historical data available
historical_signal.avg_rounds: no historical data available
Probe signal: Probe signals unavailable: probe timed out after 30s. Proceeding without probe signal.
probe_signal.test_infra: no quality infra detected
TDD suggestion: none (no_test_infra)
probe_signal.lint_format: no quality infra detected
probe_signal.type_check: no quality infra detected
probe_signal.ci: no quality infra detected
probe_signal.scripts: no quality infra detected
Grade: A
Action: dispatch allowed
```

### TDD skip reasons

When zero factors carry an applied `tdd_anchor`, the quality card records why as one of five standardized reasons (see `skills/relay-plan/scripts/quality-card.js`):

| Reason | When it applies |
|--------|------------------|
| `no_runner` | No test infra was detected (auto-derived from the probe signal; the planner does not need to declare this one) |
| `docs_only` | The diff is docs-only — nothing executable to test-drive |
| `broad_ui_judgment` | The outcome is broad visual/UX judgment, not a crisp assertion a test can pin down |
| `exploratory_task` | The task is a spike or investigation where behavior is discovered, not specified up front |
| `non_crisp_behavior` | Done Criteria describe behavior too loosely for a failing-test-first anchor |

An unrecognized skip reason string is a fail-closed error, not a silent coercion — pick one of the five values above or leave it undeclared.

## Grading logic

Apply downgrade checks first (`D`, then `C`), then assign `A` or `B`.

| Grade | Criteria | Action |
|-------|----------|--------|
| **A** | Tier minimum met + quality ratio ≥ 40% when quality factors are needed + every evaluated factor has `scoring_guide` + criteria grounded to discoverable artifacts | Dispatch allowed |
| **B** | Tier minimum met + quality ratio ≥ 25% when quality factors are needed + every evaluated factor has `scoring_guide`; or S-size mechanical task with no quality factor and a clear rationale | Dispatch allowed, but note weaker quality coverage when applicable |
| **C** | Tier minimum met, but quality is only at the exact size-based minimum for a design-bearing task OR exactly 1 evaluated factor is missing `scoring_guide` | Warning before dispatch |
| **D** | Any tier minimum violated OR hygiene check left in `factors` OR design-bearing task has no quality coverage | Dispatch blocked, revise first |

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
| `ready_light_factor_count` | Ready-light S rubric has more than 2 substantive factors without explicit risk or design-bearing rationale |
| `repo_hygiene_in_factor` | Repo-wide lint, typecheck, or test command is placed in `factors` instead of `prerequisites` |
| `over_engineering_risk` | Ready-light factor asks for unsupported helper, dependency, config, or abstraction work |
| `weak_done_criteria` | Done Criteria are not observable, bounded, reviewable, risk-aware, or verifiable |

Any check fails → revise. See `rubric-design-guide.md` for fix patterns.
