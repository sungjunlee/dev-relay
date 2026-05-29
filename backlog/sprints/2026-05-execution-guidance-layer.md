---
milestone: Sprint 2026-05 - Execution Guidance Layer
status: completed
started: 2026-05-02
completed: 2026-05-02
---

# 2026-05 Execution Guidance Layer

## Goal

Dogfood relay while implementing #394's Execution Guidance Layer. Keep guidance advisory, rubric authoritative, executor-agnostic, and measurable through run history.

## Plan

### Batch 1 - Planning model
- [x] **#395** relay-plan: add `task_profile` guidance model -> PR #404 (merged), run `issue-395-20260502063958182-55bdbb59`
  - Depends on: #394 reference doc.
  - Output: planner-visible task profile with `change_type`, `domains`, `risk_tags`, `execution_mode`, and `guidance_packs`; profile appears in generated dispatch artifacts without becoming reviewer verdict schema.
  - Tests: `node --test tests/relay-plan/scripts/*.test.js`

### Batch 2 - Guidance references
- [x] **#396** relay-plan: add compact guidance pack references -> PR #405 (merged), run `issue-396-20260502071247068-add95c75`
  - Depends on: #395 task profile.
  - Output: executor-agnostic references for `surgical-change`, `verification-evidence`, `simplify-pass`, `docs-reader-success`, and `trust-boundary`.
  - Tests: relay-plan reference contract tests plus focused concise-pack checks.

### Batch 3 - Prompt rendering
- [x] **#397** relay-plan: render `Working Guidance` in dispatch prompts -> PR #406 (merged), run `issue-397-20260502072455948-89edad42`
  - Depends on: #395 task profile and #396 guidance references.
  - Output: selected packs render only when present; no-guidance baseline stays byte-stable; TDD remains anchored by rubric factors.
  - Tests: no-pack, single-pack, multi-pack, and TDD-plus-guidance prompt emission coverage.

### Batch 4 - Run metadata
- [x] **#398** relay-dispatch: persist selected guidance packs in run artifacts and events -> PR #411 (merged), run `issue-398-20260502073638320-42327190`
  - Depends on: #397 prompt semantics.
  - Output: selected pack names and task profile summary persist as advisory metadata/events without mutating role bindings or reviewer verdicts.
  - Tests: `node --test tests/relay-dispatch/scripts/*.test.js`

### Batch 5 - Measurement
- [x] **#399** reliability-report: add guidance pack effectiveness insights -> PR #413 (merged), run `issue-399-20260502075702855-19860d9e`
  - Depends on: #398 persisted guidance data.
  - Output: usage counts, review rounds, changes-requested rate, stuck factors, and divergence summarized by guidance pack; legacy runs degrade gracefully.
  - Tests: `node --test tests/relay-dispatch/scripts/reliability-report.test.js`

## Running Context

- Reference doc: `docs/archive/plans/issue-394-execution-guidance-layer-plan.md`.
- Epic: #394. Completed doc child: #400 via PR #401. Closed implementation children: #395, #396, #397, #398, #399.
- Implementation order: #395 -> #396 -> #397 -> #398 -> #399, matching the reference doc dependency chain.
- Default workflow: `/relay` with codex executor + codex reviewer unless local evidence gives a concrete reason to change.
- Stop at `ready_to_merge` unless the operator explicitly asks to merge the PR.
- Guidance is advisory working style only. Done Criteria and rubric factors remain authoritative.
- Keep rendered packs compact and executor-agnostic; do not require provider-specific skill names or tool paths for correctness.
- Preserve old-run compatibility: no guidance metadata must not break review, dispatch, or reliability reports.
- Existing `2026-04-agentic-patterns-phase-0.md` still has `status: active` from earlier work. This sprint is the active execution focus for #394; do not reuse the completed `2026-05-workflow-foundation.md`.

## Progress

- 2026-05-02 KST: Sprint created from `origin/main` on branch `codex/issue-394-sprint-prep`. Direct `git switch main` was blocked because `main` is checked out at `/Users/sjlee/workspace/active/harness-stack/dev-relay`; this work did not start from stale `codex/issue-394-execution-guidance-docs`.
- 2026-05-02 KST: #395 relay dogfood started with codex executor + codex reviewer target. Initial run `issue-395-20260502063610517-aef068e3` was closed before implementation because the orchestrator branch would have made the PR target `codex/issue-394-sprint-prep`. Restarted from detached `origin/main`, confirmed dispatch fallback to base `main`, and opened run `issue-395-20260502063958182-55bdbb59`; manifest `~/.relay/runs/dev-relay-778886da/issue-395-20260502063958182-55bdbb59.md`; worktree `~/.relay/worktrees/4e519036/dev-relay`; branch `issue-395`.
- 2026-05-02 KST: #395 dispatch completed in 451s. PR #404 opened against `main` with commit `f9bf9f9` (`feat(relay-plan): add task profile guidance model`); manifest state `review_pending`. Next action: codex relay-review.
- 2026-05-02 KST: #395 relay-review R1 PASS with codex reviewer. PR #404 has review audit comment, manifest state `ready_to_merge`, rubric status `satisfied`. Stop here until operator explicitly asks to merge.
- 2026-05-02 KST: PR #404 GitHub Codex review raised one P2: generic `validate` text triggered `trust-boundary`. Fixed on `issue-395` with commits `39b0dd1` and `6f8e620`; added regression coverage for generic docs validation and positive `validate manifest` wording. Local `node --test tests/relay-plan/scripts/*.test.js` passed 89/89; GitHub Actions `test` and CodeRabbit pass on `6f8e620`. No current-head inline comments remain; `@codex review` was requested twice but no new Codex review was posted within the polling window.
- 2026-05-02 KST: #395 / PR #404 squash-merged after explicit operator request. Used `finalize-run.js --skip-review` with audit reason because the post-LGTM Codex P2 fix made the relay-review SHA stale but manual follow-up review, local tests, GitHub Actions, CodeRabbit, and current-head inline-comment scan were clean. Manifest state `merged`; worktree and remote branch cleaned; #395 closed.
- 2026-05-02 KST: #396 relay dogfood started from detached `origin/main` after #404 merge. Dispatch run `issue-396-20260502071247068-add95c75`; manifest `~/.relay/runs/dev-relay-778886da/issue-396-20260502071247068-add95c75.md`; worktree `~/.relay/worktrees/400f7016/dev-relay`; branch `issue-396`.
- 2026-05-02 KST: #396 dispatch completed in 240s. PR #405 opened against `main` with commit `c445c97` (`Add relay-plan guidance pack references`); manifest state `review_pending`. Next action: codex relay-review.
- 2026-05-02 KST: #396 relay-review R1 PASS with codex reviewer. PR #405 has review audit comment, manifest state `ready_to_merge`, rubric status `satisfied`. Stop here until operator explicitly asks to merge PR #405.
- 2026-05-02 KST: #396 / PR #405 squash-merged after explicit operator request. Manifest state `merged`; worktree and remote branch cleaned; #396 closed.
- 2026-05-02 KST: #397 relay dogfood started from detached `origin/main` after #405 merge. Dispatch run `issue-397-20260502072455948-89edad42`; manifest `~/.relay/runs/dev-relay-778886da/issue-397-20260502072455948-89edad42.md`; worktree `~/.relay/worktrees/ca88923c/dev-relay`; branch `issue-397`.
- 2026-05-02 KST: #397 dispatch completed in 402s. PR #406 opened against `main` with head `03013cd` (`Render working guidance in dispatch prompts`); manifest state `review_pending`. Local focused test `node --test tests/relay-plan/scripts/*.test.js` passed 96/96. Next action: codex relay-review.
- 2026-05-02 KST: #397 relay-review R1 PASS with codex reviewer. PR #406 had GitHub Actions `test` pass, CodeRabbit success status with rate-limit notice only, and no current-head inline comments. PR #406 squash-merged after explicit operator continuation request; manifest state `merged`; worktree and remote branch cleaned; #397 closed.
- 2026-05-02 KST: #398 relay dogfood started from detached `origin/main` after #406 merge. Dispatch run `issue-398-20260502073638320-42327190`; manifest `~/.relay/runs/dev-relay-778886da/issue-398-20260502073638320-42327190.md`; worktree `~/.relay/worktrees/93ac5ffb/dev-relay`; branch `issue-398`.
- 2026-05-02 KST: #398 dispatch completed in 764s. PR #411 opened against `main` with head `ca39088` (`feat: persist dispatch guidance metadata`); manifest state `review_pending`. Executor reported `node --test tests/relay-dispatch/scripts/*.test.js` passed 505/505 plus `git diff --check` pass. Next action: codex relay-review after orchestrator spot-check.
- 2026-05-02 KST: #398 orchestrator spot-check `node --test tests/relay-dispatch/scripts/*.test.js` passed 505/505. relay-review R1 PASS with codex reviewer. PR #411 had GitHub Actions `test` pass, CodeRabbit success status with rate-limit notice only, and no current-head inline comments. PR #411 squash-merged after explicit operator continuation request; manifest state `merged`; worktree and remote branch cleaned; #398 closed.
- 2026-05-02 KST: #399 relay dogfood started from detached `origin/main` after #411 merge. Dispatch run `issue-399-20260502075702855-19860d9e`; manifest `~/.relay/runs/dev-relay-778886da/issue-399-20260502075702855-19860d9e.md`; worktree `~/.relay/worktrees/4da0123d/dev-relay`; branch `issue-399`.
- 2026-05-02 KST: #399 dispatch completed in 419s. PR #413 opened against `main` with head `8c38091` (`feat: report guidance pack reliability insights`); manifest state `review_pending`. Next action: orchestrator focused test and codex relay-review.
- 2026-05-02 KST: #399 orchestrator focused test `node --test tests/relay-dispatch/scripts/reliability-report.test.js` passed 22/22. relay-review R1 PASS with codex reviewer. PR #413 had GitHub Actions `test` pass, CodeRabbit success status with rate-limit notice only, and no current-head inline comments. PR #413 squash-merged after explicit operator continuation request; manifest state `merged`; worktree and remote branch cleaned; #399 closed.
- 2026-05-02 KST: Sprint complete. All #394 child issues #395-#400 are closed.
