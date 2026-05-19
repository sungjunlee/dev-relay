---
milestone: ""
status: active
started: 2026-05-19
due: 2026-05-26
epic: 486
---

# 2026-05 Relay Skill Cleanup

## Goal

Land the craft-survey-derived simplifications under Epic #486 — make every SKILL.md declare its inputs, stop guard accretion in `relay/SKILL.md`, make the Review Loop's regression back-edge explicit, and unify skill-selection cues across the suite. No new orchestration layer.

Strategic frame (from #486):
- Manifest-backed lifecycle is the right core abstraction; this sprint preserves it.
- Each touched SKILL.md must stay under 150 lines and pass `tests/skills-lint`.
- "Harder to misuse" beats "more comprehensive" — prefer mechanical guards (drift tests, named events) over prose discipline.

## Plan

### Batch 1 — Path convention decision (gate)
- [ ] #488 docs: make relay skill command examples orchestrator-portable (~30min decision + ~1hr impl)
  - Lane: **direct** (decision-heavy, doc-only)
  - Gate rationale: #488's chosen convention (repo-relative vs `${CLAUDE_SKILL_DIR}` vs `RELAY_ROOT` per the survey comment) decides #492's surface. Must land or commit-to-direction before #492 dispatches.

### Batch 2 — Foundation (blocked on Batch 1)
- [ ] #492 docs: introduce `## Inputs` block + `RELAY_ROOT` convention across all SKILL.md (~2hr)
  - Lane: **relay** (8 SKILL.md edit + new drift test + install-graph.md update — benefits from rubric + review)
  - Depends on: #488 path convention chosen

### Batch 3 — Mainline cleanup (can start once Batch 2 dispatched)
- [ ] #494 relay: extract Step 1.5/1.7/Step 4 guards into `preflight-guards.md` + `run-preflight.js` (~3hr)
  - Lane: **relay** (new script + reference doc + relay/SKILL.md rewrite — moderate scope, deserves reviewer)
  - Parallelizable with Batch 4 (#494 only touches `relay/SKILL.md` + new files; #493/#495 touch other SKILL.md files)

### Batch 4 — Documentation polish (parallel with Batch 3)
- [ ] #493 relay-review: add (phase, outcome) transition table + named events (~1hr)
  - Lane: **relay** (single SKILL.md + named-event drift check against runner output)
- [ ] #495 docs: unify Use-this-when / Do-not-use-when sections across 6 relay skills (~1hr)
  - Lane: **direct** (mechanical, 6-file edit, low risk)

### Batch 5 — Sprint close audit
- [ ] Run `sprint-close.sh --dry-run`, promote Running Context entries to `_context.md` if any cross-sprint patterns surfaced.

## Running Context

- Comment on #488 (2026-05-18) proposes `RELAY_ROOT=${CLAUDE_SKILL_DIR}/..` as a concrete convention candidate; #492 implementation surface depends on this decision.
- Comment on #489 (2026-05-18) proposes `match-template.js` recommender + `references/index.json` SSoT as the mechanism for "default vs risk-triggered" split; if adopted there, #492's drift-test pattern (SKILL.md ↔ schema) becomes a reusable convention.
- Sibling sprints `2026-05-relay-fleet.md` (#477/#478) and `2026-05-sidecar-mvp.md` shipped — install-graph.md already reflects 7-skill suite + relay-fleet adapter. #492's RELAY_ROOT line must not accidentally signal "independent install supported."
- Epic #486 children #487/#489/#490/#491 still open and untouched — this sprint covers #488 + 4 new children only. Remaining 4 are out-of-scope; pick up in a follow-up sprint.

## Progress

- 2026-05-19: Sprint opened. Source: craft-critique + craft-survey passes on 2026-05-18; epic #486 child list extended (#492-#495); boost comments left on #488/#489.
