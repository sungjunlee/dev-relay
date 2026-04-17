# Agentic Engineering Patterns Adoption — Discussion Document

**Source**: [Simon Willison — Agentic Engineering Patterns](https://simonwillison.net/guides/agentic-engineering-patterns/) + HN discussion ([GeekNews](https://news.hada.io/topic?id=27206))
**Date**: 2026-04-12
**Scope**: dev-relay + dev-backlog
**Status**: Revised after eng-review + Codex outside voice

---

## Strategic Reframe (IMPORTANT)

The initial doc proposed 6 new patterns. Review found a load-bearing issue:

**Willison's patterns assume a human-supervised coding loop where one agent accumulates its own memory and habits. Dev-relay is not that.** It intentionally externalizes memory into manifests, rubrics, PRs, and an independent reviewer. Executor memory is low-trust by design.

That makes "agent learns over time" patterns much less valuable here than tightening the contract between planner, dispatcher, reviewer, and report consumers.

**Prior learning `[rubric-lifecycle-gap]` (confidence 9/10, 2026-04-07)** already warned: *"Relay rubric is ephemeral: generated in orchestrator context, embedded in dispatch prompt, lost after. Reviewer never sees it. Root fix is persisting rubric.yaml to run dir, not adding enforcement layers on top of a missing artifact."*

The original doc repeated that mistake — proposing new layers on top of artifacts that don't yet flow end-to-end. The revised plan starts with Phase 0: wire what exists.

---

## Context

Simon Willison의 가이드와 HN 실무 코멘트에서 추출한 패턴들을 dev-relay/dev-backlog에 적용할 수 있는지 검토한다.

### Already Covered

아래 패턴들은 dev-relay가 이미 구현 중이므로 추가 작업 불필요.

| Pattern | Current Implementation |
|---------|----------------------|
| Reviewer isolation (bias-free) | `context: fork` + adapter-level isolation enforcement |
| Verification loop | Rubric-based scoring + convergence/stuck detection |
| No unreviewed code to collaborators | relay-review as mandatory merge gate |
| Subagent role separation | orchestrator / executor / reviewer role binding |
| Appropriate PR scope | relay-intake multi-leaf splitting |
| Drift/churn detection | 3-round same-issue → auto-escalation |
| Test infrastructure detection | `probe-executor-env.js` (20+ signals) |
| Run analytics | `reliability-report.js` (tier effectiveness, divergence, factor met_rate) |

### Killed Proposals

| # | Proposal | Kill reason |
|---|----------|-------------|
| 1a | Decision log (planning rationale) | No trustworthy producer. LLM planner narrative is post-hoc prompt exhaust, not ground truth. |
| 6 | Exploratory parallel dispatch | Needs manifest redesign + comparative review mode + would run maybe once a quarter. relay-plan's rubric design already supports approach comparison. |

---

## Phase 0: Wire What Exists (PRIORITY)

Everything downstream depends on these artifacts actually flowing between phases. Building on unwired artifacts repeats the `rubric-lifecycle-gap` mistake.

### 0.1 Make `anchor.rubric_path` mandatory and visible

**Problem**: `dispatch.js:557-571` persists the rubric; `review-runner.js:266-274` can load it; but the path is optional and not surfaced in plan/review prompts.

**Fix**:
- relay-plan SKILL.md: rubric persistence is required, not optional
- Manifest `anchor.rubric_path` required for `dispatched → review_pending`
- Review prompt includes rubric content, not just Done Criteria
- `gate-check.js` rejects merge if `anchor.rubric_path` is absent

**Effort**: S | **Dependencies**: None

### 0.2 relay-plan reads reliability-report before rubric design

**Problem**: `reliability-report.js` computes rich analytics (factor met_rate, avg_rounds_to_met, stuck_factor, grade distribution, tier effectiveness, divergence hotspots). **No one reads it during planning.**

**Fix**:
- relay-plan SKILL.md: run `reliability-report.js --json` before designing rubric
- Surface "factors that historically stall" as a warning during rubric design
- No automation required — just informational input for the planner

**Effort**: S | **Dependencies**: None

### 0.3 relay-plan reads probe quality signals

**Problem**: `probe-executor-env.js:76-158` already detects test frameworks, type strictness, linters, CI. **The output isn't consumed** by rubric design.

**Fix**:
- relay-plan SKILL.md: probe before rubric design; probe output becomes an input
- Surface signals in the Rubric Quality Card: "test infra detected: jest, tsc --noEmit" → planner can reference in prerequisites
- No autonomy scoring ("bad proxy" per Codex) — just expose what exists

**Effort**: S | **Dependencies**: None

**Phase 0 success criteria**: Rubric survives from plan → dispatch → review without extraction from prompt text. Planner has access to historical analytics + probe signals. Reviewer sees the same rubric the executor iterated against.

---

## Phase 1: Trustworthy Signal Expansion (after Phase 0)

Only proceed after Phase 0 demonstrates end-to-end rubric flow in real runs.

### 1.1 Rejection Log (formerly #1b)

**Origin**: HN — "왜 이 접근을 버렸는가 기록 필수"

**Problem**: `review-runner.js:706-744` (`buildRedispatchPrompt`) already carries prior-round verdict data via `readPriorVerdicts()` + `formatPriorVerdictSummary()`. But the format is narrative, not structured per-factor. Re-dispatch loses granularity.

**Fix**: Extend `formatPriorVerdictSummary()` schema with per-factor rejection fields:

```jsonc
// stored in review-round-N-verdict.json
{
  "verdict": "changes_requested",
  "issues": [
    {
      "factor": "error recovery",
      "round": 2,
      "issue": "catch block swallows error without logging",
      "fix_direction": "add structured logging before fallback",
      "attempted_approach": "bare try/catch with console.log"
    }
  ]
}
```

Re-dispatch prompt gains "Previously rejected approaches" section, per-factor.

**Trustworthy producer**: reviewer, which is independent and anchored to rubric.

**Effort**: S | **Dependencies**: Phase 0.1 (rubric must be visible to reviewer)

### 1.2 Red/Green TDD (formerly #2, reassessed)

**Origin**: Willison — "Every good model understands 'red/green TDD' as shorthand."

**Problem**: Executor currently writes implementation and tests together or implementation first. Tests shape around implementation instead of spec.

**Fix**: Optional `tdd_mode: true` in rubric, with:
- Step 0 in iteration protocol: write failing test, commit, verify red
- Prerequisite runner temporarily excludes `tdd_anchor` paths during Step 0 (TDD-aware prerequisite)
- Post-Phase-0 commits: squash Step 0's red commit into final commit (keeps branch history clean)
- Reviewer sees TDD mode in rubric and knows to expect the test-first structure

**Caveats** (raised by Codex):
- Phase-scoped expected-failure state has ripple effects into CI, review, commit history
- `tdd_mode: true` opt-in only (planner decides). Auto-suggestion waits for Phase 2.3.

**Effort**: M (upgraded from S) | **Dependencies**: Phase 0.1 (rubric must reach reviewer)

---

## Phase 2: Consumption Integration (after Phase 1 data)

Once Phase 0+1 produce consistent artifact flow, add consumers.

### 2.1 Retrospective Integration (formerly #4, merged with consumption fix)

**Problem**: `reliability-report.js` has rich analytics but no consumer — it's write-only data.

**Fix**:
- Phase 0.2 already starts this (relay-plan reads reliability-report)
- Add qualitative annotations to the report output: which rubric design choices correlated with fast convergence, which factor types stall most
- Optional: retro event type emitted from `finalize-run.js` for future aggregation

**Effort**: M | **Dependencies**: Phase 0.2

### 2.2 Quality Signal Consumption (formerly #3, narrowed)

**Problem**: Probe signals are displayed but don't drive behavior (per Codex's "bad proxy" critique, no autonomy scoring).

**Fix**: Template-level consumption, not autonomy scoring:
- Phase 0.3 already exposes signals to planner
- Add rubric templates keyed to detected signals: "project has playwright + jest + tsc strict → use this factor template"
- Templates are deterministic — no LLM judgment on "autonomy level"

**Effort**: M | **Dependencies**: Phase 0.3

### 2.3 TDD Auto-Suggestion

**Problem**: After Phase 1.2, `tdd_mode` is opt-in. Planner may forget.

**Fix**: When probe detects test infrastructure AND the task has automated contract factors, suggest `tdd_mode: true` in Rubric Quality Card. Planner still decides.

**Effort**: S | **Dependencies**: Phase 0.3, Phase 1.2

---

## Phase 3: Experimental (after Phase 2 validates value)

### 3.1 Sprint-Close Candidate Patterns (formerly #5, refactored per Codex)

**Origin**: Willison — "Coding agents mean we only ever need to figure out a useful trick once."

**Codex critique**: "Many runs produce issue-local fixes, not conventions. Auto-appending to `_context.md` creates another stale-review queue."

**Fix (refactored)**:
- **No file mutation**. Instead: `sprint-close.sh` reports candidate patterns from the sprint's run retros
- Heuristic: a factor scored high (9/10+) across 2+ runs in the same sprint is a candidate
- Sprint close outputs to terminal: "Candidate patterns this sprint: [list]. Promote manually to _context.md if applicable."
- No contract change with dev-backlog. No auto-append.

**Effort**: S | **Dependencies**: Phase 2.1

---

## Priority Sequence (Revised)

| Phase | Items | Effort | Ships when |
|-------|-------|--------|------------|
| **0** | 0.1 rubric persistence, 0.2 reliability-report consumption, 0.3 probe consumption | S + S + S | Next |
| **1** | 1.1 rejection log, 1.2 TDD mode | S + M | After Phase 0 lands + 2 weeks data |
| **2** | 2.1 retro integration, 2.2 signal templates, 2.3 TDD auto-suggest | M + M + S | After Phase 1 data validates |
| **3** | 3.1 sprint-close candidate patterns | S | After Phase 2 shows sprint retros have signal |

---

## NOT in Scope

- **#1a Decision log (planning rationale)** — No trustworthy producer. LLM planner narrative is post-hoc prompt exhaust. Rejected.
- **#6 Exploratory parallel dispatch** — Complexity exceeds value. relay-plan's approach comparison covers it cheaper.
- **Autonomy scoring from probe signals** — "strict tsconfig = high autonomy" is a bad proxy (Codex). Use deterministic templates instead.
- **Auto-mutation of `_context.md`** — Creates stale-review queue. Sprint-close reporting only.
- **New dev-backlog integration contract sections** — Avoided by writing to Running Context (existing contract) via sprint-close report, not file write.
- **Cross-project shared artifact reader** — DRY violation flagged but deferred until 3+ consumers exist.

---

## What Already Exists (honest accounting)

| Capability | Location | Status |
|------------|----------|--------|
| Rubric persistence | `dispatch.js:557-571` | Implemented, not mandatory |
| Rubric reading in review | `review-runner.js:266-274` | Implemented, depends on anchor.rubric_path |
| Prior verdict reading | `review-runner.js` (`readPriorVerdicts`, `formatPriorVerdictSummary`) | Implemented, unstructured format |
| Test framework detection | `probe-executor-env.js:93-143` | Implemented, output unused |
| Type strictness detection | Partial (package.json only) | Extendable |
| Factor analytics | `reliability-report.js:288-368` | Implemented, no consumer |
| Rubric grade distribution | `reliability-report.js:257-282` | Implemented, no consumer |
| Cross-run factor aggregation | None | Would need for Phase 3.1 |
| Sprint file checkbox updates | `finalize-run.js` + `relay-merge/SKILL.md:60-102` | Implemented |
| Running Context append | `relay-merge/SKILL.md:74-76` (documented) | Documented, no code |

---

## Failure Modes (new codepaths from revised plan)

| Proposal | Failure mode | Test? | Error handling? | Silent? |
|----------|--------------|-------|----------------|---------|
| 0.1 | `anchor.rubric_path` missing on dispatch → reviewer gets no rubric | **CRITICAL** needs regression test | gate-check.js rejects | Currently silent; will become loud |
| 0.2 | `reliability-report.js --json` fails → planner loses context | Unit test for failure path | Fall back to "no history available" note | Acceptable with clear message |
| 0.3 | probe fails on unfamiliar project structure → planner gets empty signals | Unit test for missing configs | Fall back to "no signals detected" | Acceptable |
| 1.1 | Rejection log schema mismatch between writer and reader | Regression test on `formatPriorVerdictSummary` | Strict schema validation | Would be loud if validation fires |
| 1.2 | TDD Step 0's red commit breaks CI | Integration test with real npm test | Prerequisite runner exclusion must be robust | **CRITICAL** — silent failure here wastes an iteration |
| 2.1 | Retro annotations drift from actual data | Schema test | — | — |
| 2.2 | Template mismatch with repo structure | Unit test per template | Fall back to generic rubric | Acceptable |
| 3.1 | Sprint-close false positives (noisy candidate list) | Threshold calibration test | Tunable floor | Human filters |

**Critical gaps**: 0.1 regression test (rubric now mandatory), 1.2 TDD prerequisite exclusion correctness.

---

## Parallelization

Phase 0 items (0.1, 0.2, 0.3) are independent. Can be developed in parallel worktrees:

| Lane | Items | Modules touched | Depends on |
|------|-------|----------------|------------|
| A | 0.1 rubric persistence mandatory | dispatch.js, relay-manifest.js, gate-check.js, relay-plan SKILL.md | — |
| B | 0.2 reliability-report consumption | relay-plan SKILL.md only | — |
| C | 0.3 probe signal consumption | relay-plan SKILL.md only | — |

**Conflict**: Lanes B and C both touch relay-plan SKILL.md. Either sequential (B then C, or vice versa) or combined into one lane.

Phase 1+ is sequential (each depends on Phase 0 outcomes).

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-12 | Created initial doc | Align on direction before implementation |
| 2026-04-12 | Killed #6 | Over-engineering; plan-phase approach comparison is cheaper |
| 2026-04-12 | Split #1 into 1a/1b | Separate concerns |
| 2026-04-12 | Dropped #1a | Codex: no trustworthy producer for planner-emitted decisions |
| 2026-04-12 | Merged #4 with consumption fix | Existing reliability-report is write-only data; add consumer, not more data |
| 2026-04-12 | Narrowed #5 to sprint-close reporting | Codex: _context.md mutation creates stale-review queue |
| 2026-04-12 | Added Phase 0 (wire what exists) | Prior learning `rubric-lifecycle-gap` + Codex: don't build layers on unwired artifacts |
| 2026-04-12 | Upgraded #2 (TDD) to M effort | Codex: phase-scoped expected failures affect CI, review, commit history |
| 2026-04-12 | Deferred shared artifact reader | DRY at 2 consumers is premature abstraction |
| 2026-04-14 | **Honored the Phase 1 2-week empirical gate** | Phase 0 landed 2026-04-14 (`#148` + `#139` + `#140`); the priority table requires "2 weeks data" before Phase 1. Observed pain in last 2 weeks of iteration was line-number drift, docs-mirror staleness, and compounding sibling-axis iterations — NOT factor-rejection-repeat (#141's premise) or test-shaping-around-implementation (#142's premise). Deferring both #141 and #142 until Phase 0 produces real data. Also: #141/#142 both modify core review/dispatch machinery on thin empirical ground — the `rubric-lifecycle-gap` learning explicitly warned against this. |
| 2026-04-14 | **Prioritized Phase 0 observation-window work over Phase 1** | During the 2-week observation: (1) close observed Phase 0 follow-up defects (`#176` MED cleanup-worktrees raw `run_id` leak, `#166` MED gate-check pr_number concurrency); (2) consider line-number-drift automation and docs-mirror scaffolding — both address observed structural round-cost drivers. +2 weeks: re-read `reliability-report.js` output against actual dispatch data; ship Phase 1 items only if data shows the patterns they presume. |
