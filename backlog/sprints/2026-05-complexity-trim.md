---
milestone: Sprint 2026-05 — Complexity Trim
status: completed
started: 2026-05-21
due: 2026-05-23
---

# Complexity Trim — absorb recovery into normal flow, drop dead surface, compact refs

## Goal
Three independent simplification changes land: codex auto-recover-commit becomes the
default, the dead `model_per_phase` metric block is removed, and relay-plan's 21
reference docs consolidate to 13 — all dogfooded via a single `/relay-fleet` fan-out.

## Plan

### Batch 1 — Parallel fleet (3 independent leaves, one fleet)
- [x] #508 dispatch: default --auto-recover-commit ON for codex executor (~M) → PR #512 (merged)
- [x] #509 reliability-report: remove dead model_per_phase block (~S) → PR #511 (merged)
- [x] #510 relay-plan: consolidate 21 reference docs into 13 (~M) → PR #513 (merged)

## Running Context
- Origin: 2026-05-21 complexity analysis of dev-relay. Diagnosis findings:
  - codex `completed-uncommitted` rate ~58% over last 7 days (86/86 dispatches codex);
    `--auto-recover-commit` exists + wired (`dispatch.js:1353`) but default-OFF.
  - `model_per_phase` always reports `null` — codex CLI self-selects model; no consumer.
  - relay-plan/references monotonically grows; 6 domain axis libs + 4 pattern docs
    are mechanically consolidatable with zero content loss.
- First `/relay-fleet` dogfood — 3 independent leaves is an ideal fan-out shape.
- executor + reviewer: codex + codex (user quota preference).
- #510 must NOT touch `rubric-templates/` (the #144 YAML catalog).

## Progress
- 2026-05-21: Sprint created. Issues #508/#509/#510 filed. Dispatching via relay-fleet.
- 2026-05-21 11:43: fleet-complexity-trim fanned out 3 codex leaves in parallel — no
  worktree/issue-lock collisions. All 3 dispatched cleanly.
- 2026-05-21 ~11:48: #508/#509 codex committed → dispatch.js orchestrator opened PR #512/#511.
  #510 went `completed-uncommitted` (codex hit sandbox `index.lock` Operation-not-permitted) —
  `--auto-recover-commit` default-OFF so no auto-recovery; ran `recover-commit.js` → PR #513.
  This is the exact failure #508 fixes; a live dogfood data point for the change.
- 2026-05-21 ~12:00: relay-review (codex) — #512 R1 PASS, #511 R1 PASS, #513 R1
  changes_requested on a Done-Criteria self-contradiction (DC required "update every forward
  link" while SCOPE BOUNDARY forbade editing the two guides those links live in —
  `feedback_dc_overspec_frozen_helper`). Orchestrator amended the DC anchor + run rubric to
  permit stale-link-target rewrites; re-reviewed same SHA 156f3399 → R2 PASS (quality 4→10).
- 2026-05-21 ~12:10: #512 → merged, #511 → merged, #513 → merged. All issues auto-closed.
  Suite green; relay-plan/references confirmed 21→13.

## Outcome
- 3/3 merged in one fleet, 2 dispatch+review cycles total (#510 needed an R2 after a
  planner-side DC fix, not an executor fault).
- relay-fleet first dogfood: parallel fan-out clean, no SPOF stalls, resume not needed.
- Lesson logged: pre-flight DC audit must check that "update all X" clauses don't collide
  with SCOPE BOUNDARY exclusions naming the very files X lives in.
