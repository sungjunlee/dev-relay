---
name: relay-plan
argument-hint: "[issue-number]"
description: Convert task acceptance criteria into a scored rubric for autonomous iteration. Always used before relay-dispatch — rubric depth scales with task size.
compatibility: Requires gh CLI. Task AC reading falls back to local files or user input.
metadata:
  related-skills: "relay, relay-intake, relay-dispatch, relay-review, dev-backlog"
---

# Relay Plan

Build a scoring rubric from task Acceptance Criteria (AC), then generate a dispatch prompt that drives autonomous iteration until convergence.

## Process

### 1. Read the task

Read the normalized task source (try in order, use first that succeeds):
- Relay-ready handoff brief from relay-intake: `~/.relay/requests/<repo-slug>/<request-id>/relay-ready/<leaf-id>.md`
- Local task file: `backlog/tasks/{PREFIX}-{N} - {Title}.md`
- GitHub: `gh issue view <N>`
- User-provided description

If relay-intake already produced a handoff brief, treat that file as the source of truth instead of re-reading the raw request.

### 1.5 Read historical signal

Before designing the rubric, read the relay reliability history:

```bash
node ${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/reliability-report.js --repo . --json
```

**Informational only:** the `historical_signal.*` output does not gate dispatch, does not alter state transitions, and does not modify rubric structure. Use this `reliability-report.js` input to tighten factor wording, calibration examples, and review guidance; the existing rubric structure, grading logic, and dispatch eligibility are unchanged.

Focus on the current producer fields:

| Historical signal field | Read from | Planning use |
|-------------------------|-----------|--------------|
| `historical_signal.stuck_factors` | `factor_analysis.most_stuck_factor` plus every entry in `factor_analysis.factors` where `met_rate < 1.0` or `avg_rounds_to_met >= 3` | Surface factors that historically stall so the rubric names the weak spot directly |
| `historical_signal.divergence_hotspots` | `rubric_insights.divergence_hotspots` (top 3 by `occurrences`, carrying `factor_pattern`, `avg_delta`, and `recommendation` verbatim) | Surface disagreement hotspots so the rubric tightens examples or adds automation where useful |
| `historical_signal.avg_rounds` | `rubric_insights.tier_effectiveness.contract.avg_rounds_to_met`, `rubric_insights.tier_effectiveness.quality.avg_rounds_to_met`, and `metrics.median_rounds_to_ready` | Calibrate how sharp the contract vs quality checks need to be |

If the report returns valid JSON but there are no prior runs (`manifests: 0`, `events: 0`), treat that as empty history rather than an error.

| Case | Planner handling |
|------|------------------|
| No prior runs / empty history | `Empty-data state — historical signal not available, proceed to rubric design.` Render each `historical_signal.*` field as `no historical data available`. |
| Malformed manifest or event data | `Reliability report unavailable: <cause>. Proceeding without historical signal.` Use the first stderr line as `<cause>` and still render each `historical_signal.*` field as `no historical data available`. |
| Any other non-zero exit (missing script, broken dependency, runtime error) | `Reliability report unavailable: <cause>. Proceeding without historical signal.` Surface the first stderr line when present, otherwise the exit code, then continue rubric design. |

### 2. Build the rubric

Use the guided interview (`references/rubric-design-guide.md`) to derive factors from AC, or convert directly:

```yaml
rubric:
  setup: "npm install && npm start &"    # run before checks (if needed)
  baseline: "npm run metrics > baseline.json"  # capture before-state (if delta metrics used)

  # Prerequisites: hygiene checks. Gate — must ALL pass before factor evaluation.
  # As many as needed. Do NOT count toward factor totals.
  prerequisites:
    - command: "npm test"
      target: "exit 0"
    - command: "npx tsc --noEmit"
      target: "exit 0"

  # Factors: substantive checks only (contract + quality tiers).
  factors:
    - name: API returns cursor-paginated response
      tier: contract
      type: automated
      command: "curl -s localhost:3000/api/items?limit=10 | jq '.next_cursor'"
      target: "non-null cursor string"
      weight: required

    - name: Rate limiting enforced
      tier: contract
      type: automated
      command: "for i in $(seq 1 110); do curl -s -o /dev/null -w '%{http_code}' ...; done | tail -1"
      target: "429"
      weight: required

    - name: Pagination robustness
      tier: quality
      type: evaluated
      criteria: |
        - Last page: returns empty array + no next cursor (not null, not error)
        - Concurrent writes: cursor stable when items inserted/deleted mid-pagination
        - Large result set: query plan uses index scan (EXPLAIN ANALYZE)
        - Cursor opacity: cursor is encoded, not raw DB id exposed to client
      scoring_guide:
        low: "Happy path works, last page returns error or null cursor"
        mid: "Last page handled, but cursor is raw ID, no query plan check"
        high: "All four criteria met, cursor is opaque, query uses index"
      target: ">= 8/10"
      weight: required
```

### Tier definitions

Use the same tier judgment questions everywhere:

| Tier | Question | Placement | Examples |
|------|----------|-----------|----------|
| **Hygiene** | "Would this check apply to ANY PR in this repo?" | `prerequisites` | `npm test`, `tsc --noEmit`, `eslint` |
| **Contract** | "Does this verify a SPECIFIC AC item is implemented?" | `factors` | endpoint returns paginated response, config includes new field |
| **Quality** | "Does this probe HOW well it was designed/implemented?" | `factors` | error recovery strategy, abstraction boundaries, failure mode differentiation |

**Contract = "is it there?"**  
**Quality = "is it good?"**

| Type | How scored |
|------|-----------|
| **automated** | Run command, check output/exit code. Measure the actual outcome, not a proxy. |
| **evaluated** | Agent reads code and scores 1-10. `criteria` lists what to check (multi-line, detailed). `scoring_guide` provides 3 calibration anchors (low/mid/high) so executor and reviewer share the same scale. Think like a domain expert, not a checklist. |

| Weight | Rule |
|--------|------|
| **required** | Must meet target before PR. No cross-factor compensation — each evaluated independently. |
| **best-effort** | Note in PR if below target |
**`setup`** / **`baseline`**: Run setup commands before checks; capture baseline for delta metrics (run BEFORE changes).
**`criteria`**: Multi-line, specific bullets — not "good error handling" but "timeouts on external calls, retry with backoff."
**`scoring_guide`**: Three anchors (low/mid/high) — each tells the executor what to fix next. Shared scale between executor and reviewer. Optional `fix_hint` adds prescriptive transition guidance (low→mid, mid→high) for when descriptive anchors alone leave the executor stuck.

### Domain references (for expert perspective)

Consult `references/rubric-*.md` for specialist thinking. Design factors from AC, informed by (not copied from) references.

| Task type | Reference | Key signal |
|-----------|-----------|-----------|
| UI components, pages, interactions | `rubric-frontend.md` | Lighthouse, CLS, a11y, interaction fidelity |
| API endpoints, data layer, infra | `rubric-backend.md` | Query count, response time, failure modes |
| User input, auth, file uploads, APIs with sensitive data | `rubric-security.md` | Trust boundaries, auth coverage, injection resistance, exposure control |
| Code restructuring, migration | `rubric-refactoring.md` | Dead code delta, concept count, dependency direction |
| README, guides, API docs, specs | `rubric-documentation.md` | Reader testing score, zero-context completeness |
| Design-driven features, UX flows | `rubric-design.md` | Value → Usability → Delight hierarchy |

### 3. Validate the rubric

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

### Factor Count Rules

Prerequisites (hygiene): as many as needed, uncounted. Factors (contract + quality): no hard cap, warning at 8+.

| Size | Contract min | Quality min | Substantive total | Recommended |
|------|--------------|-------------|-------------------|-------------|
| S (1-2 AC) | ≥ 1 | ≥ 1 | 2+ | ~3 |
| M (3-4 AC) | ≥ 2 | ≥ 1 | 3+ | ~5 |
| L (5-6 AC) | ≥ 2 | ≥ 2 | 4+ | ~6 |
| XL (7+ AC) | ≥ 3 | ≥ 2 | 5+ | ~8 |

### Rubric Quality Card

Summarize the rubric before dispatch so weak calibration is visible:

```text
Populated history example
-------------------------
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
Grade: A
Action: dispatch allowed

No-history example
------------------
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
Grade: A
Action: dispatch allowed
```

#### Grading logic

Apply downgrade checks first (`D`, then `C`), then assign `A` or `B`.

| Grade | Criteria | Action |
|-------|----------|--------|
| **A** | Tier minimum met + quality ratio ≥ 40% + every evaluated factor has `scoring_guide` + criteria grounded to discoverable artifacts | Dispatch allowed |
| **B** | Tier minimum met + quality ratio ≥ 25% + every evaluated factor has `scoring_guide` | Dispatch allowed, but note weaker quality coverage |
| **C** | Tier minimum met, but quality is only at the exact size-based minimum OR exactly 1 evaluated factor is missing `scoring_guide` | Warning before dispatch |
| **D** | Any tier minimum violated OR hygiene check left in `factors` | Dispatch blocked, revise first |

Grade D means stop and revise the rubric first. Grade C means warn before dispatch and make the tradeoff explicit.

#### Risk signals

| Signal | Trigger condition |
|--------|-------------------|
| `low_quality_ratio` | Quality ratio < 25% |
| `no_automated_factor` | Zero automated checks across prerequisites + factors |
| `ungrounded_criteria` | Criteria refer to abstractions instead of discoverable artifacts |
| `vague_criteria` | Criteria contain "good", "proper", "clean", or "appropriate" |
| `proxy_metric` | Automated checks measure effort or process instead of outcome |
| `high_factor_count` | 8+ substantive factors |
| `all_contract` | Zero quality coverage beyond the size-based minimum |

Any check fails → revise. See `references/rubric-design-guide.md` for fix patterns.

### 3.5 Review the rubric (L/XL tasks)

For 5+ AC items, stress-test the rubric before dispatch. **Max 1 round**, then proceed.

| Size | AC count | Review |
|------|----------|--------|
| S/M | 1-4 | Skip |
| L | 5-6 | Stress-test: subagent games rubric (gaming vectors, coverage gaps, disappear test, Padding Test) |
| XL | 7+ or cross-domain | Stress-test + calibration simulation (parallel) |

Skip: S/M tasks, re-dispatches with iteration history, all-automated rubrics. Full protocol + prompt templates: `references/rubric-stress-test.md`

### 4. Generate dispatch prompt

Take the base template (`relay/references/prompt-template.md`) and add these sections:

- **Setup**: setup commands from rubric
- **Scoring Rubric**: automated checks table + evaluated factors table
- **Iteration Protocol** (autoloop-style measure-fix-keep):
  ```
  BEFORE LOOP: Run baseline if defined. RULE: Do NOT modify automated check commands.
  LOOP (max 5 iterations):
    0. PREREQUISITE GATE: Run all prerequisite checks. Any fails → fix before proceeding. Prerequisites are not scored, just pass/fail.
    1. Run ALL automated checks + self-evaluate ALL evaluated factors, record scores
    2. REGRESSION CHECK: Any factor previously marked locked now below target?
       → Revert this iteration's changes (git reset to previous commit)
       → Re-attempt with constraint: "Maintain [factor] at [score] while improving [target factor]"
       → Regression persists after 1 re-attempt → flag both factors, escalate
    3. Append to Score Log — mark factors that meet target as locked
    4. All required meet target → adversarial self-review:
       - Review as if you did NOT write this code and are seeing it for the first time
       - For each automated check: could the target be met by a shortcut that misses the intent?
         (e.g., stubbed endpoint returns fast but does nothing; test modified to always pass)
       - For each evaluated factor: re-read scoring_guide "high" — does it genuinely apply?
       - Check: stubs, TODOs, hardcoded values, test manipulation, placeholder returns
       → All clear → PR
       → Issues found → fix → re-score → PR
    5. Else → lowest required factor → if fix_hint exists, apply it as the starting fix → ONE focused change → commit → repeat
    6. Stuck detection (any trigger → best-effort: note in PR, continue | required: stop, create PR with partial progress):
       a) Single-factor stall: same factor below target for 3 consecutive iterations
       b) Oscillation: any two factors alternate regression across 4+ iterations
       c) Plateau: no required factor improved toward target over 2 consecutive iterations
  ```
- **Score Log**: iteration scores table in PR description (reviewer re-scores independently):
  ```
  | Factor | Target | Baseline | Iter 1 | Iter 2 | Final | Status |
  |--------|--------|----------|--------|--------|-------|--------|
  ```
  Status: `—` (not met), `locked` (met target — must not regress in subsequent iterations)

### 5. Dispatch

Write the rubric YAML to a temp file alongside the dispatch prompt. This is REQUIRED: every relay dispatch must pass `--rubric-file` so the rubric is persisted at `anchor.rubric_path` for review and merge gates.

```bash
${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/dispatch.js . \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml --timeout 3600
```

## When to use

- **Use it**: All tasks dispatched via relay — rubric depth scales with task size
- **S/M tasks**: Lightweight rubric (1-5 factors), skip stress-test
- **L/XL tasks**: Detailed rubric with stress-test and calibration
- **Re-dispatch**: Previous Score Log + reviewer feedback are automatically prepended to the prompt (see `relay-dispatch` docs)
- **Full rubric guide**: `references/rubric-design-guide.md`
