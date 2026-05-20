---
milestone: ""
status: completed
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

### Batch 1 — `## Inputs` blocks + drift test (#492, re-scoped)
- [x] #492 docs: add `## Inputs` block to all 8 SKILL.md + `skill-inputs-drift.test.js` → PR #498 (merged)
  - Lane: **relay** (8 SKILL.md edit + new drift test)
  - Re-scoped 2026-05-20: #488 was closed by parallel PR #496 (`${RELAY_SKILL_ROOT:-skills}` convention). #492 drops its own `RELAY_ROOT` proposal — `## Inputs` blocks now build on top of the merged `${RELAY_SKILL_ROOT}` convention. Re-dispatch against current main.

### Batch 2 — Mainline cleanup (can start once Batch 1 dispatched)
- [x] #494 relay: extract Step 1.5/1.7/Step 4 guards into `preflight-guards.md` + `run-preflight.js` → PR #500 (merged)
  - Lane: **relay** (new script + reference doc + relay/SKILL.md rewrite)

### Batch 3 — Documentation polish (parallel with Batch 2)
- [x] #493 relay-review: add (phase, outcome) transition table + named events → PR #499 (merged)
  - Lane: **relay** (single SKILL.md + named-event drift check against runner output)
- [x] #495 docs: unify Use-this-when / Do-not-use-when sections across 6 relay skills → PR #501 (merged)
  - Lane: **relay** (6-file edit)

### Batch 4 — Sprint close audit
- [ ] Run `sprint-close.sh --dry-run`, promote Running Context entries to `_context.md` if any cross-sprint patterns surfaced.

## Running Context

- Comment on #488 (2026-05-18) proposes `RELAY_ROOT=${CLAUDE_SKILL_DIR}/..` as a concrete convention candidate; #492 implementation surface depends on this decision.
- Comment on #489 (2026-05-18) proposes `match-template.js` recommender + `references/index.json` SSoT as the mechanism for "default vs risk-triggered" split; if adopted there, #492's drift-test pattern (SKILL.md ↔ schema) becomes a reusable convention.
- Sibling sprints `2026-05-relay-fleet.md` (#477/#478) and `2026-05-sidecar-mvp.md` shipped — install-graph.md already reflects 7-skill suite + relay-fleet adapter. #492's RELAY_ROOT line must not accidentally signal "independent install supported."
- Epic #486 children #487/#489/#490/#491 still open and untouched — this sprint covers #488 + 4 new children only. Remaining 4 are out-of-scope; pick up in a follow-up sprint.

## Progress

- 2026-05-19: Sprint opened. Source: craft-critique + craft-survey passes on 2026-05-18; epic #486 child list extended (#492-#495); boost comments left on #488/#489.
- 2026-05-20: #488 decision locked — `RELAY_ROOT` indirection adopted. Batches 1+2 merged: #488 + #492 combined into one relay run (shared 8-SKILL.md surface). Dispatching combined scope.
- 2026-05-20: Dispatched #488+#492 to codex → PR #497. Review R1 = changes_requested. While fixing, discovered parallel PR #496 (`57dcdc0`, "Simplify relay skill handoffs") already merged — it closed #487/#488/#489 and shipped the `${RELAY_SKILL_ROOT:-skills}` path convention. PR #497 was half-superseded (relay-plan/SKILL.md rewritten ~120 lines by both; convention clash). Decision: closed PR #497, accepted `${RELAY_SKILL_ROOT}` as incumbent, re-scoped #492 to `## Inputs` blocks + drift test only. Run issue-492-...f8b3c4ba closed.
- 2026-05-20: Re-dispatched re-scoped #492 to codex → PR #498 (`4fe24e7`), 9 files (8 SKILL.md + new `skill-inputs-drift.test.js`). First re-dispatch failed (stale `issue-492` branch from PR #497 still at `a4fe7fa` → origin/main merge conflict); deleted the branch, re-dispatched clean. Review R1 = LGTM clean — all 5 DCs verified, quality 9/10, no new path var.
- 2026-05-20: PR #498 squash-merged (`07a651e`), #492 closed. Batch 1 done.
- 2026-05-20: Dispatched #493 + #494 to codex in parallel (independent files: relay-review vs relay). #493 → PR #499: R1 changes_requested (compression dropped 2 advisory identifiers) → R2 PASS → squash-merged (`38cf694`), #493 closed.
- 2026-05-20: #494 → PR #500: dispatch returned completed-uncommitted → recover-commit.js → R1 changes_requested (prompt_allowed TTY-gating bug) → R2 changes_requested (in-flight route no longer short-circuited readiness probe) → R3 PASS → squash-merged (`2cb8571`), #494 closed.
- 2026-05-20: #495 → PR #501: dispatched after #493 merged (relay-review overlap cleared). R1 changes_requested (relay-ready duplicate routing section) → R2 PASS → squash-merged (`d8de514`), #495 closed. Cleanup needed manual worktree removal (review-runner left a stray rubric.yaml making the worktree dirty).
- 2026-05-20: Sprint complete — all 5 batched issues (#488 via #496, #492, #493, #494, #495) done. Epic #486 has #490/#491 still open (out of this sprint's scope).
- 2026-05-20: Sprint closed. 4/4 tasks completed.
