---
milestone: Sprint 2026-05 — Sidecar MVP
status: active
started: 2026-05-08
due: TBD
epic: 367
---

# Sidecar MVP (Epic #367)

## Goal

Add opencode-powered artifact-only sidecars that produce **advisory** context around relay runs without becoming trusted evidence or code-writing actors. Schema + events first, then runner CLI, then specific sidecars (recap → test-gap → docs-sync), then measurement.

Trust boundary (per Epic #367):
- Sidecar output is advisory, not proof.
- Sidecars must NOT modify manifest, rubric, Done Criteria, or source files.
- Reviewer prompts may read sidecar artifacts as hints, but must verify against diff/tests/criteria.

## Plan

Implementation order from Epic #367:

### Phase A — Foundation (schema + runner)

- [x] **#372 Add sidecar artifact schema and lifecycle events** — PR #448 / `b358e93` merged 2026-05-08 (codex+codex; 1 dispatch + R1 changes_requested + R2 PASS clean; 4 files +472/-0; 48 new tests; tests 1117 → 1192).
  - Deliverables: `EVENTS.SIDECAR_START/RESULT/FAILED`, `getSidecarsDir/getSidecarsIndexPath/getSidecarOutputDir` in `manifest/paths.js`, new `sidecar-store.js` (CRUD + `appendSidecarStart/Result/Failed` producers + `validateOutputPath` enforcing `sidecars/<id>/` scope), `tests/relay-dispatch/scripts/sidecar-store.test.js` (48 tests covering schema, status enum, trust_level literal, path traversal, symlink rejection, legacy-shape coexistence).
- [ ] #381 Add relay-sidecar runner CLI for artifact-only sidecars (consumes #372 helpers; opens new skill `skills/relay-sidecar/`).

### Phase B — First sidecar kind

- [ ] #373 Implement opencode context recap sidecar (first `kind` adopter).

### Phase C — Measurement

- [ ] #376 Report sidecar value in reliability-report (turn on only after at least one sidecar exists).

### Phase D — Additional kinds

- [ ] #374 Implement test-gap scout sidecar.
- [ ] #375 Implement docs-sync sidecar.

## Running Context

- **Phase A start triggered by**: Phase 3 of Epic #431 (relay-ready) is observation-gated and idle (≥20 readiness_probe events needed; 0 accumulated). Sidecar sprint picked up as forward progress; each `/relay <issue>` against this repo also accumulates probe observations as a side effect.
- **Sprint convention reference**: `backlog/sprints/_context.md` — no auto-mutation of shared files; rubric is load-bearing; reviewer independence is a feature.
- **Codex+codex workflow** is the default for this sprint (per `feedback_prefer_codex_heavy_workflow`).

## Progress

### 2026-05-08 — #372 schema + lifecycle events shipped

- Probe of #372 issue body: `bypass=true, proceed` (clarity=medium, granularity=medium, verifiability=high; explicit AC heading triggered the bypass).
- Dispatch with codex executor, M-size rubric, 4 factors (2 contract + 2 quality), explicit `forbidden_zones` per `feedback_mechanical_rename_global_sed_risk`.
- R1 status `completed-uncommitted` — codex finished work cleanly but skipped the commit; recovered via `recover-commit.js` (commit `d91e729`, PR #448 created).
- R1 review (codex): `changes_requested`. One substantive issue — `validateOutputPath` only enforced run-dir-relative, not "under `sidecars/<id>/`". Reviewer's stricter reading is consistent with DC2 + DC4 wording.
- R2 dispatch via `dispatch.js --manifest` (no pre-state-transition per `feedback_redispatch_no_premature_state_transition`); codex committed and pushed `dc4dca2` "Fix sidecar output path scoping" (+43 lines, 0 deletions).
- R2 review (codex): `pass` clean. All 5 DC verified, contract+quality+execution all pass, 0 remaining issues.
- `finalize-run.js --merge-method squash` succeeded; issue #372 auto-closed, worktree pruned, branch deleted, no force-finalize needed.

## Outstanding watch items

- Schema PR did NOT touch any forbidden zone (no backlog/, no .cache/, no docs/issue-*, no .github/workflows/) — clean first-try result confirms `forbidden_zones` rubric pattern works for additive feature work too (n=5 cumulative now: #435/#436/#437 from Epic #431 + #372 here).
- `model_per_phase` continues to log codex reviewer correctly (verifying `feedback_unblock_via_infra_pr` fix from PR #442 / #441 is durable).
