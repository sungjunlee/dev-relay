---
milestone: single-user-friction
status: active
started: 2026-08-15
due: TBD
component: "operator-surface"
---

# Single-User Friction Reduction

## Goal

Make the routine single-operator loop frictionless. The runtime already derives
one typed action per run — execute it mechanically (advance), make dangling
state visible and reclaimable (cockpit + GC), and make the docs describe the
measured system (recover = publication conveyor; crash convergence is a small
measured subset). No new lifecycle writer, facts, mutable state, or registry.

## Plan

### Batch 1 — advance driver

- [ ] #1264 — relay advance: mechanically converge derived recover actions

### Batch 2 — cockpit + GC (after Batch 1: rows name `relay-advance.js` as the next command)

- [ ] #1265 — relay-status --all cockpit + retained-worktree GC

### Batch 3 — naming honesty (docs-only; disjoint files, may interleave with Batch 2)

- [ ] #1266 — describe recover as the publication conveyor; retire stale operator references

## Running Context

- Evidence base (2026-08-15 independent review, three external models + run-store
  measurement): 96% of `recovery_applied` events are routine
  publication/verification; the crash rule fired in 8/52 vNext runs (15.4%, above
  the harness-criterion cut threshold — crash machinery stays). August consumer
  runs: 29/30 did not reach a clean terminal fact. Operator gotcha memory ≈ 50
  entries — the friction metric this sprint drives down.
- Model routing (operator instruction, 2026-08-15): mix codex and claude at
  appropriate levels; claude-fable is excluded from implementation and review
  roles. Codex and Claude quotas both have headroom.
- Dogfood: each issue ships through relay itself (repo-path scripts, GitHub
  route, explicit stop at `ready_to_merge`). Dispatches are serialized — two
  concurrent full gates have produced load flakes before.
- KPIs instead of a freeze: consumer time-to-reviewed-result and dangling ratio
  (August baseline 29/30).
- Deferred from the same review: rubric task-shape templates, invocation
  unification (installed vs repo-path), review round cap, fleet doc retirement,
  sprint-writer relocation to dev-backlog.

## Progress

- 2026-08-15 — Sprint admitted from the single-user friction review. Created
  #1264/#1265/#1266; batch order strict for #1264→#1265 (cockpit rows reference
  the advance CLI), #1266 disjoint.
