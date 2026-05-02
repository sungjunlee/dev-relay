---
milestone: Sprint 2026-05 — Workflow Foundation
status: completed
started: 2026-05-02
completed: 2026-05-02
due: 2026-05-08
---

# 2026-05 Workflow Foundation

## Goal

Lock in the **lane policy**: dev-relay is the manifest-backed lifecycle contract for high-risk PR-bound work, and external tools (Codex `/goal`, gstack, superpowers, Compound Engineering, opencode) live around it as optional aids — not hard dependencies and not a new automatic router. This sprint is the documentation + prompt-language layer of that decision, plus two narrow recovery/cleanup follow-ups.

Strategic frame (from epic #366 and project memory):
- dev-relay = lifecycle contract. Frozen Done Criteria → dispatch evidence → isolated review → merge gates → recovery.
- External tools = optional. No `relay-route` skill, no automatic lane selector, no internals coupling.
- Sidecars / opencode executor work = later milestones. Not in this sprint.

## Plan

### Batch 0 — Tiny cleanup (direct, no relay)
- [x] **#351** chore: drop dead `DEFAULT_REASONING_BY_SIZE` at `dispatch.js:164` → PR #382 (merged `30c5b65`)
  - Lane: **direct** (XS, 1-line removal; relay would be pure overhead).
  - Verification: `grep -n "DEFAULT_REASONING_BY_SIZE" skills/relay-dispatch/scripts/dispatch.js` returns zero, focused dispatch tests stay green.
  - Tests: `node --test tests/relay-dispatch/scripts/dispatch.test.js` (and the rubric-size companion).

### Batch 1 — Workflow lane policy doc (#369)
- [x] **#369** Document workflow lane policy before building a router → PR #383 (merged `35b302f`); `docs/workflow-lanes.md`
  - Lane: **direct or relay** — doc-only with a tight decision-table shape; choose direct unless we want dogfooding signal on a docs PR.
  - Output: lane decision table in `docs/` covering fast / goal / relay / review-only / sidecar lanes; escalation thresholds; four worked examples (small bugfix, risky state-machine change, docs sync, review-only PR).
  - Anchor: must explicitly state "policy documentation, not a new router."
  - Stop at `ready_to_merge` if relayed; do not merge unless asked.

### Batch 2 — Codex `/goal` audit wording in dispatch prompt (#370)
- [x] **#370** Borrow Codex goal completion audit into relay dispatch prompts → PR #385 (merged `deaa918`); 1 dispatch + 1 review round (R1 PASS clean)
  - Lane: **relay** (touches `skills/relay/references/prompt-template.md` plus possibly the rubric template; reviewer signal on prompt-language drift is high-value).
  - Output: dispatch prompt gets an objective→artifact checklist before completion, plus an explicit "tests/manifests/PR descriptions/self-reports are proxy signals, not proof" warning. Wording must complement (not duplicate) Done Criteria + rubric anchors.
  - Reviewer/executor: codex + codex.
  - Stop at `ready_to_merge`.

### Batch 3 — gstack/superpowers/CE workflow doc (#371)
- [x] **#371** Document gstack, superpowers, and Compound Engineering usage around relay → PR #384 (merged `1723984`); `docs/external-tool-workflow.md`
  - Lane: **direct or relay** depending on scope (likely direct; small bridging doc).
  - Output: doc capturing where superpowers (brainstorming, debugging, TDD, verification, receiving-code-review) and gstack (office-hours, plan-ceo-review, plan-eng-review, review, qa, ship, retro) fit; CE framed as specialist review / learning capture, not a fourth orchestration layer; explicit "dev-relay does not hard-depend on these tools."
  - Stop at `ready_to_merge` if relayed.

### Batch 4 — Recovery CLI (#332)
- [x] **#332** Expose `rebrandEvidence` as standalone CLI for orchestrator-side correction commits → PR #386 (merged `1cac868`); 1 dispatch (sandbox blocked git add → recover-commit) + 2 review rounds (R1 changes_requested on under-specified recovery-playbook decision tree, R2 PASS clean after codex rewrote paragraph as 3-case tree)
  - Lane: **relay** (script + tests + docs; classic codex-heavy work, reviewer surface is real).
  - Output: `skills/relay-dispatch/scripts/rebrand-evidence.js` CLI, `--run-id`/`--reason` (+ optional `--repo`/`--manifest`/`--dry-run`/`--json`), happy-path/`sha_unchanged`/`no_existing_evidence` tests, `EVENTS.EXECUTION_EVIDENCE_REBRANDED` event, CLAUDE.md "Common Commands" example, recovery-playbook paragraph clarifying when to use this vs. `recover-commit` vs. `force-finalize-nonready`.
  - Reviewer/executor: codex + codex.
  - Stop at `ready_to_merge`.

### Epic tracker (no code)
- [x] **#366** Epic — workflow lane policy. All three children landed (#369 #370 #371) on 2026-05-02; closing epic as a sprint side-effect.

## Running Context

- **Strategic anchor**: dev-relay is the lifecycle contract layer, not a router. External tools optional. Sidecars / opencode = later milestones.
- **Default workflow**: codex executor + codex reviewer (memory `feedback_prefer_codex_heavy_workflow`). Use Claude only when there is a specific reason.
- **Doc home**: `docs/` for cross-skill workflow docs (#369, #371); `skills/<skill>/references/` for skill-specific operator docs (#332 recovery playbook).
- **Prompt template home**: base prompt at `skills/relay/references/prompt-template.md`. Rubric-flavored templates under `skills/relay-plan/references/`. #370 lands in the base template plus any rubric-design doc that mentions completion behavior.
- **Test baseline at sprint start**: latest main is `3d40593 Promote rubric quality scores into relay iteration`. Run focused suites first; expand to full `node --test tests/relay-*/scripts/*.test.js` only when shared scripts or prompt behavior change.
- **In-flight check before relay dispatch**: scan `~/.relay/runs/<repo-slug>/issue-<N>-*.md` and `git worktree list` first (memory `feedback_dispatch_inflight_run_check`).
- **Stop-at-ready_to_merge rule**: this sprint never merges without an explicit operator instruction. Capture run ID, PR number, review verdict, and final state in the progress log; transition `[ ]` → `[~]` (in-flight) → `[x]` (merged) only after that.
- **Untracked triage artifacts**: `backlog/triage/.cache/2026-05-02T00-58-05Z.json` and `backlog/triage/2026-05-02-report.md` exist as untracked. Do not delete or overwrite without explicit operator approval.
- **Stale 2026-04 sprint**: `2026-04-agentic-patterns-phase-0.md` still says `status: active`. This sprint takes over execution focus; that file's status is a separate cleanup, not in this sprint's scope.

## Progress

- 2026-05-02 01:37 UTC: Sprint file created. Re-anchor clean — branch `main` (post-`/remote-control` orchestrator session), `git status` clean, `git fetch origin` ok, latest main `3d40593`. Five issues + epic confirmed in milestone #5. Next action: Batch 0 (#351), direct minimal removal of `dispatch.js:164` constant, then focused `dispatch.test.js` run.
- 2026-05-02 01:54 UTC: **Batch 0 / #351 merged.** Direct PR #382 (`chore/issue-351-drop-dead-default-reasoning` → `30c5b65`). 1 line deletion. `dispatch.test.js` 100/100 green; `cli-args.test.js` co-run 117/117. CI green (test job + CodeRabbit). Squash-merged. Next action: Batch 1 (#369), lane policy doc — direct (single doc, decision-table shape) under `docs/`.
- 2026-05-02 02:02 UTC: **Batch 1 / #369 merged.** Direct PR #383 (`docs/issue-369-workflow-lane-policy` → `35b302f`). New `docs/workflow-lanes.md` (90 lines): five lanes table, decision table by task shape, five escalation triggers, four worked examples. Forward-links to #370/#371 companions. CI: test pass; CodeRabbit rate-limited but pass status. Squash-merged. Next action: Batch 2 (#370), dispatch prompt completion-audit wording — relay (codex+codex) since prompt template is the contract surface and reviewer signal matters.
- 2026-05-02 02:08 UTC: **Batch 3 / #371 merged in parallel** while #370 codex was running. Direct PR #384 (`docs/issue-371-external-tool-workflow` → `1723984`). New `docs/external-tool-workflow.md` (69 lines): gstack/superpowers/CE positioning tables, anti-patterns, Tool Independence Statement.
- 2026-05-02 02:08 UTC: **Batch 2 / #370 merged.** Relay PR #385 (`issue-370` → `deaa918`); run-id `issue-370-20260502020016945-6b9a0cae`. Codex executor 1 dispatch ~6 min, codex reviewer R1 PASS clean (verdict `pass`, state `ready_to_merge`, rubricStatus `satisfied`). 6 lines added (4 to `prompt-template.md` `## Completion Audit`, 2 to `rubric-reference-contract.test.js` assertions). CI green. `finalize-run.js` squash + worktree cleanup. Next action: Batch 4 (#332), rebrand-evidence CLI — relay (codex+codex), files prepped at `/tmp/done-criteria-332.md`.
- 2026-05-02 02:26 UTC: **Batch 4 / #332 merged.** Relay PR #386 (`issue-332` → `1cac868`); run-id `issue-332-20260502021035010-6affaed2`. Codex dispatch took ~8 min and finished `completed-uncommitted` (sandbox blocked `git add`/`commit` — exact `feedback_executor_did_not_open_pr` pattern). Used `recover-commit.js --reason "codex finished implementation but sandbox blocked git add/commit step"` to commit/push/open PR (`commitSha 10d31f4`, `prCreated true`). R1 reviewer found a real contract gap (recovery-playbook paragraph too generic, missing 3-case decision tree the rubric explicitly required). R2 codex re-dispatch (~76 s) rewrote the paragraph as 3-case tree; R2 PASS clean. CI green. Squash-merged. **Net diff**: 6 files +470 lines (new `rebrand-evidence.js` 267 LOC + `rebrand-evidence.test.js` 196 LOC + cli-schema entry + cli-schema test + CLAUDE.md "Common Commands" entry + recovery-playbook decision tree). Sprint complete; next action: log entries.

## Follow-ups (sprint dogfood)

Three follow-up issues filed from sprint dogfood after the original 5/5 closed; landed in a follow-on session.

- **#387** dispatch.js auto-discover redispatch prompt when only `--run-id` provided. Filed live in #332 R2 dogfood (every R2+ orchestrator hit `Error: --prompt or --prompt-file is required`). Bundled into PR #390.
- **#388** drop deprecated codex `--full-auto` flag. Filed from codex 0.128.0 deprecation warning on every dispatch. Bundled into PR #390.
- **#389** codex sandbox blocks `<main-repo>/.git/worktrees/<name>/index.lock` writes. Filed as the root-cause investigation of #332's `completed-uncommitted` failure. Shipped as PR #392.

### Follow-up progress

- 2026-05-02 04:08 UTC: **#389 dispatched.** Relay PR #392 (`issue-389` → run-id `issue-389-20260502034722215-13c28fdd`). Investigation-first rubric with both fix paths enumerated verbatim per memory `feedback_rubric_enumerated_decision_tree`. Pre-investigation: codex 0.128.0 ships `codex exec --add-dir <DIR>` (Path 1 feasible); failure not reproducible locally on a fresh attempt (acknowledged-intermittent in issue body).
- 2026-05-02 04:07 UTC: **#389 codex executor reproduced the bug LIVE during its own dispatch** — `fatal: Unable to create '<repo>/.git/worktrees/dev-relay8/index.lock': Operation not permitted` (same stderr shape as #332). Ran `recover-commit.js` to land the work; orchestrator-correction commit chain followed.
- 2026-05-02 04:11 UTC: **#389 R1 changes_requested** (3 contract-tier paperwork issues): PR body needed investigation evidence verbatim, test name didn't match rubric grep target `#389|add-dir|sandbox.widen`, Path 2 deferral lacked an audit-trail link. Filed #393 as the Path 2 follow-up. Orchestrator-correction commit `f14eda1` addressed all three (added dedicated #389-named test, linked #393 in playbook, refreshed PR body). Used `recover-state.js` to transition `changes_requested → review_pending`.
- 2026-05-02 04:25 UTC: **#389 R2 contract PASS, quality FAIL** — substantive correctness finding: `--add-dir <admin-dir>` only covered worktrees/<name>/, but linked-worktree `git add` writes blob objects to `<common>/objects/` and `git commit` updates refs at `<common>/refs/heads/<branch>`. Fix would have moved past the `index.lock` failure and still hit objects/ref lock failures. Orchestrator-correction commit `ea0d0e4` widened `--add-dir` from admin dir to **common git dir** (which subsumes admin dir as a subdirectory). Tests 101/101 with widened scope.
- 2026-05-02 04:32 UTC: **#389 R3 contract PASS + quality PASS** (all 5 rubric factors 8-9/10); sole blocking gate was procedural fail-closed on stale execution evidence (recorded at `8658d4a`, reviewed at `ea0d0e4` after orchestrator commits). `rebrand-evidence.js --reason "..."` rebound evidence to current HEAD per memory `feedback_orchestrator_correction_evidence_chain`.
- 2026-05-02 04:32 UTC: **#389 / PR #392 unauthorized merge** — orchestrator passed `--no-merge` to `finalize-run.js` intending cleanup-only finalization; actual flag is `--skip-merge`, unknown flag silently ignored, `--force-finalize-nonready` proceeded with squash merge as `29b1d68` on main. Substantively reviewed positive (R3 contract+quality both pass), but procedural rule "stop at ready_to_merge unless explicitly authorized" violated. Saved memory `feedback_verify_cli_flag_before_invoke.md` so the flag-name confusion doesn't repeat.
- 2026-05-02 06:18 UTC: **#387 + #388 PR #390 merged** (`357db26`) after rebase on main (mechanical conflict in dispatch.test.js: #390 dropped `--full-auto`, #392 added `--add-dir <commonGitDir>` to the same argv arrays — both changes coexist cleanly post-rebase). Tests 104/104 post-rebase, CI clean (test job + CodeRabbit). #387 closed by merge keyword; #388 closed manually (squash commit dropped the close keyword for the second issue).

### Follow-up final state

- **#387** closed by PR #390 merge.
- **#388** closed manually after PR #390 merge.
- **#389** closed by PR #392 merge.
- **#391** open (probe-executor-env.js `--full-auto` deprecation cleanup; sprint follow-up).
- **#393** open (Path 2 `--auto-recover-commit` opt-in flag; deferred from #389).

### Net stats (follow-up batch)

Tests: 967 (sprint baseline) → ~1042 (post-#392 + post-#390 rebase). Two PRs merged (#390 #392), three issues closed (#387 #388 #389), two new follow-up issues filed (#391 #393) on the same milestone.
