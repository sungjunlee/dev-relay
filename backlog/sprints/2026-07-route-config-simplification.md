---
milestone: Route Config Simplification
status: active
started: 2026-07-05
due: TBD
objectives: []
component: "dispatch-execution"
---

# route-config-simplification

## Goal
Route selection is one user-facing concept: a single routes.json schema (open-by-default, strict opt-in) drives dispatch/review routing, presets make per-run intent one word, and relay-config can audit and revise its own config — so agent delegation stops requiring memorized flags or forgotten setup.

## Plan

### Batch 1 — substrate + independent bugfix (parallelizable)

- [x] #784 relay-config inspect: opencode/pi model-list probes time out (ETIMEDOUT at 5s) — S, ~1 relay run; independent of the phase chain, good parallel candidate alongside #781
- [~] #781 Routes single concept: unified routes.json, open-by-default posture, strict opt-in (Phase A) — L; split as A1 loader/gate/posture/event/ADR → A2 relay-config vocabulary → A3 friction wiring + doc banners; A1 merged (PR #792), A2 merged (PR #804), A3 remaining

### Batch 2 — per-run UX (blocked by #781)

- [ ] #782 Route presets: --route-preset, /relay natural-language mapping, model catalog (Phase B) — M

### Batch 3 — self-audit (blocked by #781)

- [ ] #783 relay-config revise mode: gaps --json, conversational amendments, migrate (Phase C) — M; degrades gracefully without #782 (preset_broken gap type inert until presets exist)

### Unplanned (found during Batch 1 execution)

- [x] #786 close-run cannot close runs whose worktree was pruned by dispatch signal cleanup — S; superseded by #785 (other session's three-case worktree matrix, PR #797); PR #789 closed unmerged, part 2 follow-up tracked in #785's thread
- [ ] #795 dispatch branches from local main; unpushed local commits contaminate every PR diff — filed after the same scope-noise finding cost one review round on each of PR #789/#791/#792 (rule of three)
- [ ] #805 validateManifestPaths rejects relay worktrees for runs dispatched from a linked worktree (basename mismatch) — S; blocked recover-commit/recover-state/review-runner/gate-check for the A2 run; verified workaround: `--manifest` form without `--repo`
- [ ] #807 finalize-run post-merge crash (runCleanup removes worktree → getCanonicalRepoRoot on it; writeManifest is last) leaves run stuck at ready_to_merge — S; A2 run completed manually via updateManifestState+writeManifest + cleanup_result event
- [ ] #808 finalize-run pre-merge CI gate blocks already-MERGED PRs on never-completing checks (CodeRabbit PENDING after branch delete) — S; ordering fix: fetch merge state before assertPreMergeSafety

## Running Context

- Design reference: `docs/route-config-simplification-design.md`. Dependency chain: #781 → #782 → #783; #784 independent.
- Posture flip is a shipped-behavior change: no-config default goes fail-closed → open. Legacy `policy.json` holders keep current semantics until migrated (#781 loading order). ADR 0007 required in the #781 PR.
- `evaluateRelayRoute()` must stay unchanged — routes config maps to the policy-shaped object in memory. No derived policy.json file (drift is the disease being treated).
- `UNREGISTERED_ROUTE_USED` goes into the frozen EVENTS enum with write-time validation coverage (#313 pattern); consumers are #783 gaps and reliability-report.
- SKILL.md prose is pinned by sibling test suites (PR #746 incident): every phase that rewords SKILL.md runs the FULL repo suite.
- relay-config is a wrapper (skills/relay-config) delegating to a core script (skills/relay-dispatch/scripts/relay-config.js): vocabulary rename lands in both; `allow-route` alias kept one release.
- Phase D (relay-plan route recommendation + fleet per-leaf fill) is NOT in this sprint — observe-gated on ≥~10 non-default-route runs over ~4 weeks after A–C ship.

## Progress

### 2026-07-06 (A2 merge)
- PR #804 squash-merged on user instruction. The landing itself surfaced two more finalize-run defects, both filed: #808 (pre-merge CI gate runs before already-MERGED detection; first `test IN_PROGRESS` on the fresh push, then `CodeRabbit PENDING` that only cleared minutes after branch delete) and #807 (post-merge crash: runCleanup removes the worktree, a follow-on path calls getCanonicalRepoRoot on it, and writeManifest — the LAST step — never runs, so merge_finalize events journal but the manifest sticks at ready_to_merge; retries impossible in any configuration).
- Also hit during landing: gate-check has no --manifest form, so #805 blocks it entirely for linked-worktree runs (finalize-run's internal audit re-check covered the gate); a silent earlier push failure meant R2 review passed against local 630d7ac while the PR head was still 1c7cb08 — caught by finalize's fresh-review gate (stale), fixed by pushing before retry.
- Run completed manually per #807 comment: updateManifestState→merged + writeManifest via node (validateTransition machinery), cleanup_result event with reason manual_cleanup_after_finalize_crash_807, worktree pruned + local branch deleted. Issue #781 reopened 3× (auto-closed by #792 squash, #804 merge, then finalize retries' best-effort issue close) — stays open for A3.
- Other session landed #803 (#800 crash-only Phase 1: non-destructive signal handling in dispatch.js) — future harness kills should no longer prune worktrees mid-dispatch.
- Next: A3 (friction wiring + doc banners) + #805 fix are disjoint file surfaces — parallel dispatch candidates on merged main.

### 2026-07-06 (A2)
- #781 A2 dispatched on merged A1 (run `issue-781-20260706000901940-2ab48b13`, codex, branch issue-781-a2). Issue #781 had been auto-closed by PR #792's squash merge — reopened with rationale (A2/A3 remain).
- Harness kill recurred (~01:05, dispatch PID + codex both dead, no JSON emitted) AFTER codex finished implementing (5 files, +483/-149, targeted 31/31 green in worktree). Salvage playbook applied: orchestrator verification (full suite FULL_SUITE_DONE exit=0) → provenance commit 1c7cb08 → two-hop recover-state → PR #804 → evidence via execution-evidence.js helpers.
- NEW INFRA BUG filed as #805: runs dispatched from a linked worktree (Claude's .claude/worktrees/*) fail validateManifestPaths in recover-commit/recover-state/review-runner — relay worktree basename (dispatching root) vs canonicalized primary root basename mismatch. Verified workaround used throughout: `--manifest <path>` form without `--repo` (expectedRepoRoot undefined → validates against manifest's own repo_root).
- R1 CHANGES_REQUESTED, 3 real findings: init lost overwrite semantics (preserved existing fields + couldn't recover from invalid routes.json); PR-body test-edit enumeration incomplete (orchestrator-authored body missed 3 wrapper-suite edits); legacy-shadow warning three states asserted only in JSON mode. Fixed as orchestrator-correction (630d7ac): commandInit rebuilt from scratch, text-mode three-state test, full 10-item enumeration. Note: profile enum guard was UNREACHABLE (cli-schema.js --profile allowedValues already enforces) — pinned existing behavior in a test instead of adding dead code.
- R2 full-suite gate: one relay-review contention flake (different test failed on each run; isolated reruns 429/429 + skills-lint 24/24) — deflake-by-isolation per playbook, rerun note appended to evidence log.
- R2 PASS → `ready_to_merge` (PR #804, rounds 2, all DC VERIFIED). Stopped before merge per protocol.

### 2026-07-06 (merge)
- Batch 1 landed on user instruction. Merge audit first surfaced a parallel-session collision: PR #789 (#786 part 1) conflicted with main because the other session's #797 (#785) fixed the same vanished-worktree dead-end via a more general three-case ownership matrix, and the owner had already closed #786 as fixed-by-#785. Remaining #789 diff added no behavior main doesn't enforce → PR #789 closed unmerged with rationale, run closed. Precedent applied: close superseded PR; no narrow follow-up needed (part 2 lives in #785's thread).
- #791 (#784) and #792 (#781 A1) squash-merged via finalize-run; both learnings pushes hit the expected post-merge fetch race → rebase + push each time. Full suite on merged main (with #796/#797 in the mix): 1612 pass / 0 fail.
- Next: #781 A2 (relay-config vocabulary) can now dispatch on merged A1; then A3, then Batch 2 (#782). #795 still open in Unplanned.
- #781-A1 converged to PASS at R11 (PR #792 `ready_to_merge`). Review rounds R2–R10 each caught a real, progressively narrower defect in the salvaged loader: strict-omission materialization defeating the merge guard (R2), the same bug via the v1 path + event-journal-level suppression verification (R3), managed_cli shape drift from DC §3 (R4), project-only routes bypassing legacy precedence (R5), per-preset validation + fully-inert project parsing without global (R6), legacy planner failing on v2 project files → `ignored_v2` (R7), complete F2 test-edit enumeration in PR body — 11 items (R8), cwd fallback leaking foreign project executor_defaults (R9), null optional defaults erasing inherited values (R10).
- Convergence pattern worth keeping: fail-closed→open posture flips have a long tail of "who else materializes the default" sites (validator, v1 converter, merge, resolver fallbacks). Rubric factor F2's "legacy byte-identical + justify every test edit" did the heavy lifting.
- All three Batch-1 PRs now `ready_to_merge`: #789 (#786 part 1), #791 (#784), #792 (#781 A1). Merge order when instructed: #789/#791 independent; #792 first of the #781 chain (A2 vocabulary depends on it).

### 2026-07-05 (continued, 2)
- #784 R1 hit the same stranded-learnings-commit scope finding as #789; same remedy (merge origin/main into branch). Evidence had to be authored by orchestrator (executor died before writing execution-evidence.json): real full-suite run teed to result file, evidence built via execution-evidence.js helpers (schema needs command/cwd/head_sha/exit_code/recorded_by/recorded_at + one of output_hash/stdout_hash/stderr_hash). R2 PASS → `ready_to_merge` (PR #791).
- #781-A1 salvage: codex work verified near-complete (loader/mapping/ADR/event all present). 9 suite failures triaged: 3 contention flakes (timing/SIGINT/fleet), 6 real posture-flip reconciliations — legacy no-config denial tests now seed `routes.json {version:2, strict:true}` fixtures to keep denial coverage (relay-policy-gate, probe-executor-env, review-runner-advisory ×4). 53/53 green after reconcile.

### 2026-07-05 (continued)
- Harness background-task kills recurred (06:42, 07:42, 07:59 — kills follow orchestrator turn end, not a fixed schedule). Adapted: long operations now run foreground within a turn; codex work salvaged from surviving worktrees instead of re-dispatching.
- #786: R2 fix survived in worktree; orchestrator verified (close-run + full suite green), recovered via force rollback → review_pending → manual commit `2cfdbc3` + rebrand-evidence. R3 verdict PASS → `ready_to_merge` (PR #789).
- #784: executor's 4-line fix survived; 126 stray unstaged deletions restored via `git ls-files --deleted | git restore`. Orchestrator added the one missing warning-token assertion, committed `01f31aa`, opened PR #791. execution-evidence.json was never written (executor killed early) — evidence rebuilt from a real orchestrator-run full suite before review.
- Learning: recover-state whitelist requires two hops from `dispatched` (`--force` → changes_requested → review_pending), and changes_requested→review_pending gates on a NEW pushed commit; commit first, then transition.

### 2026-07-05
- Sprint planned. Design doc committed (72fab9f), issues #781–#784 created with milestone "Route Config Simplification", task mirrors synced (81f79c6).
- Batch 1 dual-dispatch (codex+codex): #784 run `issue-784-20260705061528614-395cfc3a` (root cause pre-measured: opencode ~10.0s, pi ~8.1s vs 5s budget; fix = default 20000 + actionable warning + doc line). #781 A1 on branch `issue-781-a1` (loader/mapping/posture-flip/UNREGISTERED_ROUTE_USED/ADR 0007). File surfaces verified disjoint.
- Planning shape-check: open-mode gate reuses EXISTING `unknown_allowed` reason from evaluateRelayRoute (relay-policy.js:566) — design doc's `unregistered_route_open_mode` reason name corrected at dispatch, gate function stays byte-identical.
- Note: another session is running relay on this repo today (#768 run 06:08, #765 recovery commit) — expect push races; rebase before push.
- 06:42 incident: both Batch 1 background dispatches SIGTERM-killed pre-commit. dispatch.js cleanup() removed worktrees but left manifests `dispatched`; close-run then threw on the missing worktree path. Recovered via temporary detached worktrees + close-run + fresh re-dispatch (runs `...c4ed5772` #784, `...aefaea7c` #781-A1). Zero executor work lost (verified: branch commits were only origin/main advances).
- Filed #786 for the recovery gap: close-run misses `acceptPrunedRelayOwned: true` (escape hatch exists in validateManifestPaths; cleanup-worktrees already uses it). Part 1 dispatched as third parallel run (branch issue-786); part 2 (signal-handler manifest stamping in dispatch.js) deferred behind A1 to avoid file collision.
