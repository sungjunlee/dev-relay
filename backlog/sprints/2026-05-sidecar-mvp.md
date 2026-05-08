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
- [x] **#381 Add relay-sidecar runner CLI for artifact-only sidecars** — PR #449 / `37615114` merged 2026-05-08 (codex+codex; 1 dispatch + R1 changes_requested + R2 PASS clean; 3 files +717/-0; 7 new runner tests).
  - Deliverables: new skill `skills/relay-sidecar/` with `SKILL.md` + `scripts/relay-sidecar.js` (CLI, `bindCliArgs` schema, injectable opencode factory, fail-closed advisory enforcement via `git status --porcelain` pre/post snapshot, `output.md` always — R1 fix decoupled runner `--json` from sidecar output filename per DC5 independence requirement), `tests/relay-sidecar/scripts/relay-sidecar.test.js` (7 tests: --help, --dry-run, happy path, opencode non-zero exit, advisory violation, unknown executor, sidecar id shape).

### Phase B — First sidecar kind

- [x] **#373 Implement opencode context recap sidecar** — PR #450 / `8c822f9d` merged 2026-05-08 (codex+codex; 1 dispatch + R1 changes_requested + R2 PASS clean; 4 files +697/-15).
  - Deliverables: new `skills/relay-sidecar/scripts/kinds/context-recap.js` (pure `buildRecap` with 5 required `##` sections, `buildOpencodeAugmentationPrompt`, no IO/async/opencode requires), runner gained kind dispatch + `--executor none` path for kinds with deterministic builders, no-claims-of-completion guard tested against all 5 forbidden phrases, `tests/relay-sidecar/scripts/kinds/context-recap.test.js` + extensions to runner test (26 sidecar+kind tests total). Independence-from-opencode AC met: tests for `--executor none` import zero opencode-related modules.

### Phase C — Measurement

- [x] **#376 Report sidecar value in reliability-report** — PR #451 / `06d1d461` merged 2026-05-08 (codex+codex; 1 dispatch + R1 changes_requested + R2 PASS clean; 2 files +511/-3; +7 new tests).
  - Deliverables: new `buildSidecarInsights({ events, manifests, repoRoot })` function; top-level `report.sidecar_insights` JSON field with `total_invocations`, `by_kind`/`by_executor`/`by_model`/`by_provider` buckets (with `successes`/`failures` outcome split for kind+executor), `failure_rate`, `predicted_findings_match_rate` (best-effort substring heuristic; word-level matching after R1 fix), `predicted_findings_runs_examined`. Human-readable surface mirrors guidance-pack style (`sidecar_insights: no sidecar runs available` for empty case; full block when populated; prediction lines suppressed when `null`). All 28 existing reliability-report tests preserved unchanged. Empty-state shape verified live: `{total_invocations: 0, ..., predicted_findings_match_rate: null}` no crash.

### Phase D — Additional kinds

- [x] **#374 Implement test-gap scout sidecar** — PR #452 / `89b60191` merged 2026-05-08 (codex+codex; 1 dispatch + R1 changes_requested + R2 changes_requested + R3 changes_requested + R4 PASS clean; 4 files +736/-22; +10 new tests = 26→36 total).
  - Deliverables: new `skills/relay-sidecar/scripts/kinds/test-gap.js` (5 required `##` sections; rubric block-scalar parser; required-vs-optional mutual-exclusion; 4-bullet confidence/limitations disclaimer including the absence-of-signal limitation), runner gained `test-gap` registration + opt-in `runContext` extras (`rubric`/`doneCriteria`/`diff` via symlink-refusing reads + PR-diff fallback), bypass `appendSidecarStart` with direct `appendRunEvent` call from runner to attach `trust_level: "advisory"` to start events without modifying frozen sidecar-store.js. Status `completed` on first dispatch — first time this batch codex committed + opened PR itself (no recover-commit). Required FOUR rounds total — R2 caught a YAML block-scalar miss + scope-drift modification of `sidecar-store.js`; R3 still flagged `sidecar_start trust_level` requiring an in-scope direct-event-write workaround; R4 clean.

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

### 2026-05-08 — #381 runner CLI shipped (Phase A complete)

- Probe of #381: `qa_needed` (granularity=low, "not single-leaf"). Orchestrator overrode after manual single-leaf judgment — issue describes one CLI with internal sub-components, not multiple deliverables. Probe's signal reflects body verbosity, not actual scope multiplicity. Drafted explicit DC enumerating 9 sub-criteria to compensate.
- Dispatch with codex executor, M-size rubric, 4 factors (2 contract + 2 quality). `forbidden_zones` extended to enumerate every existing skill/test directory as off-limits (allowed-zone = `skills/relay-sidecar/**` + `tests/relay-sidecar/**` only).
- R1 status `completed-uncommitted` → `recover-commit.js` → commit `56ee463`, PR #449 created.
- R1 review: `changes_requested`. One issue — runner `--json` was incorrectly coupled to sidecar output filename selection (`output.json`), but DC5 explicitly required these be independent concerns.
- R2 dispatch via `dispatch.js --manifest`; codex committed `5a279c6` "Fix relay-sidecar JSON output artifact path" (decoupled the two — sidecar output is always `output.md` for now; future kinds can introduce alternate formats).
- R2 review: `pass` clean. All 8 DC verified, contract+quality+execution all pass, 0 issues.
- `finalize-run.js --merge-method squash`; issue #381 auto-closed, no force-finalize.
- **Phase A foundation complete**. #373/#374/#375 (specific sidecar kinds) are now unblocked.

## Outstanding watch items

### 2026-05-08 — #373 context-recap kind shipped (Phase B kickoff)

- Probe of #373: clarity=low, granularity=low, verifiability=low, "not single-leaf" — body genuinely vague ("highlights repeated findings", "likely misses"). Compensated by drafting an explicit 7-item DC enumerating recap content, no-claims-of-completion guard, and `--executor none` independence from opencode.
- Dispatch (codex executor, M-size, 4-factor rubric — 2 contract + 2 quality with explicit forbidden_zones).
- R1 status `completed-uncommitted` → `recover-commit.js` → commit `0ec7351`, PR #450 created.
- R1 review: `changes_requested` with 2 issues — (1) repeated-findings detector matched only `title`, AC required "title or body"; (2) Likely-misses forbidden-zone heuristic hardcoded only the universal subset (backlog/cache/docs/issue/.github), missing the rubric's full forbidden_zones list (read-only skill dirs).
- R2 dispatch via `dispatch.js --manifest`; codex committed `2bdbf5b` "Fix context recap review heuristics" — added body fallback + read forbidden_zones from rubric.yaml + tests for both fixes.
- R2 review: `pass` clean. All DC verified, contract+quality+execution all pass, 0 issues.
- `finalize-run.js --merge-method squash`; issue #373 auto-closed; no force-finalize.
- **Phase B kickoff complete**. #374 (test-gap) and #375 (docs-sync) sidecars are next.

## Outstanding watch items

### 2026-05-08 — #376 sidecar metrics shipped (Phase C complete)

- Probe of #376: clarity=low, granularity=medium, verifiability=low — body sparse on prediction-heuristic specifics. Compensated with explicit 7-item DC including precise empty-state JSON shape and shared-substring heuristic semantics.
- Dispatch (codex executor, M-size, 4-factor rubric — 2 contract + 2 quality). Forbidden_zones expanded to enumerate every relay-dispatch internal file EXCEPT `reliability-report.js`, plus all other skills.
- R1 status `completed-uncommitted` → `recover-commit.js` → commit `b5e63ba`, PR #451.
- R1 review: `changes_requested` with 1 issue — prediction heuristic implemented as `output.includes(fullTitle)` rather than shared-partial-substring. Reviewer correctly identified ambiguity in DC4 wording: "literal substring of [the] title" was implemented as full-title match but the reviewer's reading (and the `output_path` example test case) required word-level/partial substring matching. Spec-precision issue, not implementation defect.
- R2 dispatch via `dispatch.js --manifest`; codex committed `724716d` "Fix sidecar prediction substring matching" — switched to word-level matching after tokenizing title.
- R2 review: `pass` clean. All 7 DC verified, contract+quality both pass, 0 issues.
- `finalize-run.js --merge-method squash`; issue #376 auto-closed; no force-finalize.
- **Phase C complete**. `sidecar_insights` is now live on `main` (verified empty-state output post-merge).

## Outstanding watch items

### 2026-05-08 — #374 test-gap kind shipped (Phase D first kind, 4-round outlier)

- Probe: clarity=low, granularity=medium, verifiability=low — body sparse on heuristic specifics.
- Dispatch (codex executor, M-size, 4-factor rubric).
- Status `completed` on R1 — first time this Sidecar batch codex committed + opened PR itself (commit `1b9ded1`, no recover-commit needed).
- R1 review: 3 issues — `loadTestGapExtras` used raw `fs.readFileSync` not symlink-refusing helper + dropped PR-diff fallback; confidence disclaimer missed the "absence of gap signal" limitation; `sidecar_start` lacked `trust_level: "advisory"` (DC AC6 over-specification by orchestrator).
- R2 dispatch (commit `2eea0f4`): codex addressed all 3 R1 issues but introduced two new problems — (a) rubric command extractor only handled inline scalars, missing YAML block-scalar `command: |` form (which is the more common shape — including this very rubric); (b) to add `trust_level` to start events, codex modified the FROZEN `skills/relay-dispatch/scripts/sidecar-store.js` and its test, breaking forbidden_zones.
- R2 review: changes_requested with 2 deepening findings (block-scalar miss + scope drift). R2 redispatch prompt augmented by orchestrator addendum directing revert of relay-dispatch changes + acknowledging AC6's `trust_level on start` was over-specified (should drop the assertion).
- R3 dispatch (commit `96075c2`): codex reverted relay-dispatch changes + fixed block-scalar handling. But R3 reviewer still flagged `sidecar_start trust_level` since it reads the FROZEN DC anchor (not the redispatch addendum), keeping AC6's literal wording.
- R3 redispatch prompt augmented by SECOND orchestrator addendum: satisfy AC6 in-scope by bypassing `appendSidecarStart` and calling `appendRunEvent` directly from `relay-sidecar.js` with `trust_level: SIDECAR_TRUST_LEVEL` passed through (`appendRunEvent`'s eventData passthrough block already supports the field per #372).
- R4 dispatch (commit `d8baf7f`): codex implemented the bypass cleanly. Diff stayed within 4 expected files.
- R4 review: PASS clean. All 9 DC items VERIFIED, 0 issues.
- `finalize-run.js --merge-method squash`; issue #374 auto-closed; no force-finalize.
- **Phase D first kind shipped, but at 4 rounds is the outlier** of this Sidecar batch (n=4 prior were all 2 rounds). Cause analysis: AC6 over-specification + reviewer-anchors-to-frozen-DC interaction. Future kind PRs should NOT specify `trust_level` on `sidecar_start` in DC.

## Outstanding watch items

- Pattern n=9 cumulative now (Epic #431: #435/#436/#437/#444; Sidecar: #372/#381/#373/#376/#374). `forbidden_zones` adherence ROBUST across mechanical renames, schema additions, new-skill builds, kind-module additions, surgical extensions, AND second-kind additions (with one false start in #374 R2 caught and corrected).
- **Reviewer-anchored-to-frozen-DC pattern** (#374 only): when DC over-specifies a field and the implementation legitimately can't satisfy it without scope drift, the redispatch addendum can direct the bypass — but the reviewer keeps anchoring to the frozen DC each round, requiring orchestrator to ensure the in-scope satisfaction path is BOTH directed AND code-implementable. Lesson: pre-flight DC review for unintended over-specification (particularly cross-PR contract claims like "X event also has Y field" where X's helper is in a frozen scope).
- Both PRs landed `completed-uncommitted` → `recover-commit` flow on first dispatch. recover_commit_rate ticked up from 0.117 to 0.125 (over 1 baseline run) and is expected to keep rising while codex CLI's commit-skip behavior persists. Not a blocker; the recovery path is fully automated.
- R1 catches both PRs were spec-precision issues (output_path scope on #372, runner `--json` independence on #381) — not implementation defects. The DC's explicit enumeration of edge cases is doing real work; R1 reviewer correctly held the line. No reviewer-side defects observed.
- `model_per_phase` continues to log codex reviewer correctly (verifying `feedback_unblock_via_infra_pr` fix from PR #442 / #441 is durable across both PRs).
