---
milestone: PR #276 follow-ups (W17 cleanup)
status: active
started: 2026-04-24
due: TBD
---

# PR #276 follow-ups — reviewer-bundle, recovery CLI, hygiene

## Goal
Close the five follow-up issues filed from the PR #276 (#271 CLI flag schema migration) retrospective so that the next codex-heavy executor cycle no longer rediscovers the same friction surfaces (reviewer-bundle blindness, ad-hoc commit recovery, ambiguous finalize flags, codex timeout fragility).

## Plan
Sequencing reflects priority **and** blast radius. #277 lands first because it auto-retires #278; #281 second because every future executor timeout benefits; the rest are small/independent.

### Batch 1 — Reviewer-bundle (highest leverage)
- [x] #277 review-runner snapshot PR description into review bundle (~30 min) → PR #282 (merged, 2 rounds)
  - Auto-retires #278 once landed (gate that #278 forbids becomes observable).
  - Success signal: `<run-dir>/review-round-<N>-pr-body.md` written before reviewer invocation; reviewer prompt explicitly cites the snapshot path; tests cover both `gh pr view` success and failure (non-fatal, surfaced in events).
  - Reviewer/executor: codex + codex.

### Batch 2 — Operator recovery CLI (compounding DX)
- [x] #281 `relay-recover-commit` named command (~1.5 hr) → PR #283 (merged via force-finalize-nonready: stale-execution-evidence)
  - Promotes the canonical "commit + push + PR" recovery pattern (memory `feedback_executor_did_not_open_pr`) from ad-hoc shell to a named, audited script.
  - Success signal: `skills/relay-dispatch/scripts/recover-commit.js` lands; new flags registered in `cli-schema.js` (verbatim for `--reason`/`--pr-title`/`--pr-body-file`, parsed for the rest); tests cover happy path, no-changes-to-commit rejection, run-id resolution failure, dry-run preview, missing-`--reason` validation; emits `recover_commit` event; stamps `pr_number` on manifest if missing without changing state; memory `feedback_executor_did_not_open_pr` updated to reference the command.
  - Reviewer/executor: codex + codex.

### Batch 3 — Operator clarity (tiny)
- [ ] #279 `finalize-run --help` decision tree (~10 min)
  - Disambiguates `--skip-review` vs `--force-finalize-nonready` after observing operator misuse twice this week.
  - Success signal: `--help` output includes the four-row decision tree; no behavior change; existing finalize-run tests still pass.
  - Reviewer/executor: codex + codex.

### Batch 4 — Rubric-author guidance (reassess after #277)
- [ ] #278 rubric-design "no PR-description gates" paragraph (~15 min)
  - **Decision deferred until #277 PR drafted**: if the #277 PR includes the guidance inline (a single paragraph in `rubric-design.md` cross-linking #277), close #278 as inlined. Otherwise ship as a standalone docs-only PR.
  - Success signal (standalone path): one paragraph added to `skills/relay-plan/references/rubric-design.md`; no new files; cross-references #277 so the constraint auto-expires when #277 lands.

### Batch 5 — Codex timeout bump (low-confidence, bundle or defer)
- [ ] #280 codex executor default timeout 1800→2400s (~10 min)
  - One direct data point (PR #271). Either bundle into the #281 PR (recovery CLI + timeout bump in one commit) or ship at the end of the sprint as a one-line PR.
  - Success signal: codex default 2400s, other executors unchanged; `--help` reflects new default; existing dispatch tests still pass.
  - Reviewer/executor: codex + codex.

## Running Context
- **Default workflow**: codex executor + codex reviewer (memory `feedback_prefer_codex_heavy_workflow` — user's codex quota >> claude quota).
- **Reviewer-bundle limitation is structural**: the reviewer sandbox cannot read PR body via `gh pr view` from inside the bundle. Until #277 lands, do NOT phrase rubric gates as "PR description contains X" (memory `feedback_reviewer_cannot_see_pr_body`).
- **Detached HEAD trap**: dispatch from `main` only. If a parallel run leaves the worktree on detached HEAD, base_branch captures literal `'HEAD'` and `gh pr create` fails at the tail end (memory `feedback_dispatch_detached_head`).
- **Test baseline**: 802 tests green (`node --test skills/relay-*/scripts/*.test.js`).
- **Force-finalize escape**: `--force-finalize-nonready --reason "..."` is canonical for legitimate escalation escapes (reviewer-bundle limitation, progressive-deepening false positives). Document the reason explicitly — it's the audit trail.
- **Repo-path scripts during active dev**: use `node skills/relay-*/scripts/...` from the repo root; `~/.agents/skills/` copies refresh via `npx skills add sungjunlee/dev-relay` after merging changes (memory `project_stale_installed_skills`).

### Cross-issue dependencies
- **#277 → #278**: #278 acceptance is contingent on #277 because #278's "retire this constraint once the reviewer bundle includes PR body" line points directly at #277's deliverable. Either inline #278's paragraph into the #277 PR (preferred, cuts a round-trip) or close #278 immediately after #277 lands with the paragraph as a follow-on commit.
- **#281 ↔ #280**: orthogonal but both touch dispatch/recovery. Optionally bundle #280 into the #281 PR — saves a review round, costs nothing in scope clarity (the timeout bump's rationale is exactly the recovery scenario the new command addresses).

## Progress
- 2026-04-24 02:50 UTC: Sprint file created. Pre-session sync clean (`origin/main` up-to-date, baseline 802 tests). Five issues filed end of prior session (#277-#281); all loaded with full bodies inspected. Next action: dispatch #277 via `/relay` with codex executor + codex reviewer.
- 2026-04-24 02:57 UTC: First #277 dispatch failed at 36s — codex 0.122.0 + global config `model = "gpt-5.5"` rejected by OpenAI API ("does not exist or you do not have access"). Run `issue-277-20260424025725102-b29be6ef` closed cleanly via `close-run.js`. Operator upgraded codex CLI 0.122.0 → 0.124.0; direct `codex exec --model gpt-5.5` then verified working.
- 2026-04-24 03:42 UTC: Re-dispatched #277 (run `issue-277-20260424034232725-ae96b1e2`, codex 0.124.0/gpt-5.5/xhigh, timeout 2400s). Codex completed in 591s with `status: completed-uncommitted` — exact `feedback_executor_did_not_open_pr` pattern. Implementation across 5 modified + 1 new file (`review-runner/pr-body-snapshot.js`, 76 lines); 807 tests pass (+5 over 802 baseline). Manually committed (`f4839ae`), pushed `issue-277`, opened PR #282.
- 2026-04-24 03:58 UTC: Round 1 codex review = `changes_requested`. Contract PASS (4/4 rubric factors + 5/5 DCs verified) but Quality FAIL on one HIGH security issue: PR-body snapshot section in `prompt.js` lacked a data-boundary tag, so PR body content (executor-authored external text) could carry reviewer instructions like "return pass". Execution-evidence flagged stale-artifact (tests at `71e28c2` pre-commit, review at `f4839ae` post-commit) — known recovery-pattern artifact, not a real defect.
- 2026-04-24 04:03 UTC: Round 2 dispatched via `--run-id` resume (initial `--branch` re-dispatch failed because worktree already held the branch — gap worth noting; #281 should expose `relay-recover-commit` resume-aware). Codex committed `3461401` "Guard PR body snapshot prompt boundary" in 192s — this round codex auto-committed cleanly (no recovery needed). 4-line diff across `prompt.js` + 2 test files adds the trust-boundary language.
- 2026-04-24 04:07 UTC: Round 2 codex review = `pass` → state `ready_to_merge`. Stopping here per session task spec; awaiting operator merge approval on PR #282.
- 2026-04-24 04:47 UTC: Operator approved continuation. PR #282 merged via `finalize-run --merge-method squash`. Issue 277 closed; main fast-forwarded; baseline now 807 tests.
- 2026-04-24 04:52 UTC: #281 dispatched (run `issue-281-20260424045210944-373e0915`, codex 0.124.0/gpt-5.5/xhigh, timeout 2400s). Codex completed in 1000s with `status: completed-uncommitted` (the very pattern this PR retires — recursive). Implementation: 3 new files (`recover-commit.js` 402 lines, `recover-commit.test.js` 316 lines, shared `manifest/pr-number-stamp.js` 173 lines extracted from gate-check.js) + 5 modified; 820 tests pass (+13 over 807 baseline). Manually committed (`39bf5cf`), pushed `issue-281`, opened PR #283. Memory file `feedback_executor_did_not_open_pr.md` outside sandbox — codex couldn't write; orchestrator updated post-implementation.
- 2026-04-24 05:14 UTC: Round 1 codex review = `changes_requested`. 4/5 rubric factors PASS, sole blocker: memory file not yet updated to reference recover-commit (codex sandbox boundary). Orchestrator updated `feedback_executor_did_not_open_pr.md` + MEMORY.md index, mirrored guidance into `relay-dispatch/SKILL.md` ("Executor completed but did not commit" section), committed `334262c` to PR #283. Used `recover-state.js --to review_pending --reason "..."` to transition `changes_requested → review_pending` (precondition: fresh commit at `334262c`).
- 2026-04-24 05:24 UTC: Round 2 codex review = ALL 5 rubric factors PASS, Contract PASS, Quality PASS — but review-runner downgraded to `changes_requested` because execution-evidence.json was bound to base SHA `4fddd8d` (pre-orchestrator-commits). Orchestrator re-ran tests at HEAD `334262c` (820 pass), refreshed `execution-evidence.json` via `buildExecutionEvidence` helper. `recover-state --force` refused to retransition because HEAD == last_reviewed_sha (unconditional guard). Force-finalized via `--force-finalize-nonready --reason "stale-execution-evidence: reviewer rd2 PASS, all 5/5 factors verified, evidence refreshed at reviewed HEAD by orchestrator"`. PR #283 merged as `d106d75`.
- 2026-04-24 05:28 UTC: Filed follow-up #284 — `relay-record-execution` operator command for evidence refresh after recovery commits (Option A) OR relaxing `recover-state --force` HEAD-equality guard (Option B). Names the structural defect that #281 doesn't cover.
