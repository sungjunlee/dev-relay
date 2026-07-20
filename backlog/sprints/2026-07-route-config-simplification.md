---
milestone: Route Config Simplification
status: completed
started: 2026-07-05
due: TBD
objectives: []
component: "dispatch-execution"
---

# route-config-simplification

## Goal
Route selection is one user-facing concept: a single routes.json schema drives dispatch/review routing, presets and provider-aware model resolution make per-run intent compact, relay-config can audit/revise its own config, and the remaining dispatch/fleet test gates are stable enough to trust while finishing the work.

## Plan

### Batch 1 — substrate + independent bugfix (parallelizable)

- [x] #784 relay-config inspect: opencode/pi model-list probes time out (ETIMEDOUT at 5s) — S, ~1 relay run; independent of the phase chain, good parallel candidate alongside #781
- [x] #781 Routes single concept: unified routes.json, open-by-default posture, strict opt-in (Phase A) — A1 PR #792, A2 PR #804, A3 PR #811 all merged; #781 closed, Phase A complete

### Batch 2 — per-run UX (blocked by #781)

- [x] #782 Route presets: --route-preset, /relay natural-language mapping, model catalog (Phase B) → PR #813 **merged** 2026-07-07 (LGTM round 7; rebased onto post-Batch-1 main, then 5 review-driven corrections)

### Batch 3 — stability rebaseline before more broad relay-config work

- [x] #816 parallel full-suite / relay-fleet condition-wait rebaseline — Linux fleet solo 89/89; no fleet failure reproduced, so closed with evidence and no fleet wait or command-shape change. Adjacent advisory audit race split to #1039 → PR #1038 (reviewing).

### Batch 4 — self-audit (Phase C, now unblocked)

- [ ] #783 relay-config revise mode: gaps --json, conversational amendments, migrate (Phase C) — **deferred to backlog 2026-07-20**; stale PR #848 closed unmerged and its relay run closed. Replan from current main rather than replaying the conflicting branch.

### Batch 5 — linked-worktree base correctness

- [x] #809 linked-worktree dispatch records invalid local-only base branch — closed 2026-07-09 after the remote-valid base and linked-worktree corrections landed.

### Batch 6 — provider-aware model resolution hardening

- [x] #833 fixture-drive live model-list parser coverage — closed by PR #837.
- [x] #834 model catalog freshness reporting — closed by PR #837.

### Unplanned (found during Batch 1 execution)

- [x] #786 close-run cannot close runs whose worktree was pruned by dispatch signal cleanup — S; superseded by #785 (other session's three-case worktree matrix, PR #797); PR #789 closed unmerged, part 2 follow-up tracked in #785's thread
- [x] #795 dispatch branches from local main; unpushed local commits contaminate every PR diff — closed 2026-07-09 after the base-resolution work removed the reported behavior.
- [x] #805 validateManifestPaths rejects relay worktrees for runs dispatched from a linked worktree (basename mismatch) — PR #810 merged; fix proven live by gate-check passing for PR #811 via normal --repo resolution
- [x] #809 promoted into Batch 5 after #815/#819 closed and #825 landed; work status is tracked by the Batch 5 Plan item.
- [x] #807 finalize-run post-merge crash — resolved via PR #814.
- [x] #808 finalize-run pre-merge CI gate blocks already-MERGED PRs — resolved via PR #814.
- [x] #815 flaky test: dispatch SIGINT descendant-survival warning intermittently missing → **resolved by other session, PR #836** (stabilize SIGINT descendant survival fixture)
- [x] #819 relay-dispatch signal tests leak SIGTERM-ignoring codex fixtures — THE root cause of the 2026-07-07 "relay-fleet flakes" + suite hangs → **resolved by other session, PR #835** (clean up relay dispatch signal fixtures)

## Running Context

- Design reference: `docs/route-config-simplification-design.md`. Dependency chain: #781 → #782 → #783; #784 independent.
- Posture flip is a shipped-behavior change: no-config default goes fail-closed → open. Legacy `policy.json` holders keep current semantics until migrated (#781 loading order). ADR 0007 required in the #781 PR.
- `evaluateRelayRoute()` must stay unchanged — routes config maps to the policy-shaped object in memory. No derived policy.json file (drift is the disease being treated).
- `UNREGISTERED_ROUTE_USED` goes into the frozen EVENTS enum with write-time validation coverage (#313 pattern); consumers are #783 gaps and reliability-report.
- SKILL.md prose is pinned by sibling test suites (PR #746 incident): every phase that rewords SKILL.md runs the FULL repo suite.
- relay-config is a wrapper (skills/relay-config) delegating to a core script (skills/relay-dispatch/scripts/relay-config.js): vocabulary rename lands in both; `allow-route` alias kept one release.
- Phase D (relay-plan route recommendation + fleet per-leaf fill) is NOT in this sprint — observe-gated on ≥~10 non-default-route runs over ~4 weeks after A–C ship.

## Progress

### 2026-07-20 (closeout reconciliation)
- Reconciled the sprint against current GitHub state: #795 and #809 were already closed on 2026-07-09, and #833/#834 were closed by PR #837. PR #1038 for the #816-adjacent audit fix has also merged.
- Deferred #783 without claiming completion. PR #848 was 79 commits behind current main and conflicting after the risk-adaptive redesign, so it was closed unmerged; relay run `issue-783-20260708123338704-4521864f` was closed through the normal validated transition. #783 remains open and unmilestoned for a fresh current-main replan.
- With every remaining milestone item completed or explicitly returned to backlog, this sprint can close early and the Assurance and Calibration Integrity sprint can become the single active execution hub.

### 2026-07-19 (#816 rebaseline and narrow audit fix)
- Rebaselined `edcff70` in a clean WSL2 Linux ext4 clone with Node v22.22.3. Relay-fleet solo passed 89/89 with no fixture processes before or after.
- The current CI globs without `--test-concurrency=1` reproduced no fleet wait failure. It exposed the tracked advisory-family race instead: the standard gating lane had already demoted the verdict while `ADVISORY_REVIEW` was still absent.
- Added a deterministic RED→GREEN regression and reused the existing event-binding wait for decision-changing gating successes. Hardened behavior remains unchanged; standard non-gating paths remain lightweight.
- Final Linux evidence: advisory file 81/81; explicit parallel full suite 2,555 tests, 2,553 passed, 0 failed, 2 skipped; fixture processes 0 before/after. Independent code review PASS with no findings.
- Closed #816 on rebaseline evidence. Registered the distinct advisory defect as #1039 and kept its implementation/review lifecycle in PR #1038.

### 2026-07-08 (replanned after #825/#826/#815/#819 landed)
- Refreshed the open follow-up set against current main and GitHub state: #825/#820-#824 closed by PR #831, #826/#827-#830 closed by PR #832, #819 closed by PR #835, and #815 closed by PR #836. The remaining sprint work should not rebuild those surfaces.
- Updated issue scopes for #816, #809, #833, and #834. #816 is now the first rebaseline gate: verify whether the relay-fleet condition-wait failure still exists after the signal-fixture fixes before broad relay-config work resumes.
- Reordered the remaining work into small batches: #816 stability rebaseline → #783 Phase C self-audit → #809 linked-worktree remote-base correctness → #833 parser fixtures → #834 informational catalog freshness report. #795 stays deferred/related unless #809's narrow remote-base fix naturally covers it.
- #783 remains unblocked, but its scope stays intentionally narrow: `gaps`/`migrate`/`revise` should use the post-#831 resolver context without absorbing catalog freshness or parser drift reporting from #833/#834.

### 2026-07-08 12:20 (window opened; other session landed both new epics)
- **Other session shipped both new epics + two of this sprint's Unplanned bugs**, all merged to main (HEAD `c9bc690`): #831 = Epic #825 provider-aware model resolution (one PR, #820-#825 closed); #832 = Epic #826 operational visibility (`run-observer.js` + `relay-status.js` + `relay-recover`, #826-#830 closed); #835 fixed #819 (fixture leak I filed); #836 fixed #815 (SIGINT flake). Both epics disjoint from #783's surface (verified: #832 = all new files; #831 = `resolve-model` in relay-config.js, no `gaps`/`migrate`/`revise`).
- **Environment recovered**: disk 1.3Gi→8.0Gi (user cleared), load 42→7.6, 0 leaked fixtures. **#783 unblocked.**
- **#783 replan note (post-#831)**: relay-config.js is now 1034 lines and model resolution exists. Open scope question for the plan: keep #783's `gaps` to its original 7 gap types (AC-frozen), or add a model-resolution-health type (e.g. `unresolved_preset_model` / `stale_catalog`) now that #831's resolver + catalog fallback are live. Original AC is the review anchor; any added type must be a deliberate AC amendment, not scope creep. `migrate` scope unchanged (policy.json/executors.json/v1 routes → unified; resolver config is already unified).

### 2026-07-08 (Batch 2 merged; #783 held on cross-session contention)
- **Both Batch 2 PRs merged** (user instruction): #813 (#782 route presets) 2026-07-07 23:05, #814 (#807/#808 finalize-run resilience) 2026-07-07 23:04. main HEAD `29fd532`. **Only #783 (Phase C) remains** in the sprint plan; Phase D still observe-gated.
- **Two new epics are owned by ANOTHER session/agent — not this session's work**: #825 (Provider-aware model resolution: #820-#824) and #826 (Operational visibility: #827-#830). #825 is the natural sequel to #782 (its #822/#824 extend #782's just-merged preset-CRUD flag validation + route-plan snapshot attribution). #826 is orthogonal (runtime visibility) but productizes the salvage/observe pain this sprint hit repeatedly (#829 ⊃ the recover-state playbook, relates #806/#755; #830 relates #815/#816/#819).
- **#783 HELD, not dispatched.** The other session has `issue-825` LIVE (`dispatched`, branch `issue-825-model-resolution`, worktree `14f58ef0`, codex, base `29fd532`) — a broad epic-level run editing `relay-config.js`/route-plan, the exact disjoint surface #783 needs. Concurrent dispatch = guaranteed cross-session conflict. Compounding: disk `/System/Volumes/Data` at 1.3Gi free / 100% capacity → ENOSPC risk for a 2nd concurrent codex dispatch (same failure mode as the 2026-07-07 session). Resume #783 once #825 lands (clears relay-config.js) and disk is freed; rebase onto whatever #825 merges.
- **#816 ≠ #819 (not a dup; both real).** #816 = parallel test-FILE concurrency contention flakes fleet's ~4.4s condition-wait windows even on a quiet machine (8 fleet failures under zero external load) → fix is option B (widen root-caused windows). #819 = leaked SIGTERM-ignoring codex fixtures drive machine load and *compound* the flakes. Related, distinct root causes. Reaped leaked fixtures again this session (1 → 0).
- **PRD gap noted**: epics #825/#826 cite `docs/model-resolution-prd.md` and `docs/operational-observability-prd.md` as Source, but neither is committed to any branch/history here (may be uncommitted-local in the other session). Flagged for the owning session to commit — the durable source axis should live in-repo.

### 2026-07-07/08 (Batch 2 → both ready_to_merge)
- **Both Batch 2 PRs reached ready_to_merge; neither merged (awaiting explicit instruction).** #813 (#782) LGTM round 7; #814 (#807/#808) LGTM round 9.
- **Root cause of the session-long "relay-fleet flakes" identified: it was never flaky code.** (1) Disk hit 100% (ENOSPC) — empty task-output files + suite "failures" were write failures; user cleared it (DaisyDisk). (2) The relay-dispatch SIGINT/leader-exit tests leak fake-`codex` fixture processes that run `process.on('SIGTERM',()=>{}); setInterval(...)` from temp dirs and **ignore SIGTERM by design**; across days of killed suite runs ~13 leaked (1-day+ ELAPSED), driving load average to 54-95 and hanging/flaking the subprocess/timing suites (relay-fleet resume, dispatch interruption, microbenchmark p95). Reaped with `pkill -9 -f relay-codex`; load fell to ~14 and the affected suites ran green. Fix belongs in the tests (teardown must SIGKILL spawned fixture PIDs) — file as relay-dispatch test-hygiene follow-up. Memory: `feedback_dispatch_signal_tests_leak_fixtures`.
- #814 (#807/#808) R6-R9 orchestrator-corrections, each with full-suite/relay-merge evidence + recover-state re-review: R6 ran the fresh review gate on the terminal-merged retry path (remote-branch delete); R7 (deepening) fetched review-only inputs so the merged path skips CI/mergeability but still gates review; R8 (new) preserved the skip-review audit trail on the already-merged path; R9 (new) restricted the merged branch+pr auto-retry selector to runs with pending cleanup (no duplicate post-merge side effects on completed runs). R9 PASS, 0 issues.
- #813 (#782) rebased onto post-Batch-1 main (2 additive conflicts: cli-schema flag-list union + relay-config.test import union), force-pushed, re-reviewed. R3 escalated (flip-flop on preset-expansion / snapshot-attribution factors) → owner fix: explicit `--review-assurance` now seeds the run intent before preset expansion and the snapshot only attributes what the preset actually applied. R4 (2 newly_scoreable): DC6 no-preset byte-identical (gated route-derived assurance on `--route-preset`) + SKILL.md trimmed 156→149. R5 (2 new): advisory model must not inherit a different planned reviewer's model; preset show/remove reject add-only flags. R6 (deepening): detect bare add-only flags by presence (hasCliFlag), not value. R7 PASS, 0 issues.
- Every orchestrator-correction round: authored execution-evidence at the committed head, `recover-state` (changes_requested/escalated → review_pending, `--force` for escalated), then `review-runner` — the same audited-transition discipline as Batch 1 salvages. All relay tooling used the `--manifest` form (#805 linked-worktree).

### 2026-07-06 (Phase A complete + Batch 2 dispatch)
- PR #810 (#805) merged first — finalize-run completed CLEANLY this time (worktree intact, no recreate dance). PR #811 (A3) then gate-checked via the NORMAL --repo path — the just-merged #805 fix proving itself live — and merged; learnings push race resolved by rebase+push as usual. #781 CLOSED: Phase A (A1 PR #792 → A2 PR #804 → A3 PR #811) complete.
- #809 second symptom: finalize's learnings push had published `origin/worktree-floofy-seeking-music`; the stale remote branch made both new dispatches fail at base-merge (`failed to merge origin/worktree-floofy-seeking-music into worktree`). Deleted the remote branch, commented on #809 (fix should also stop learnings pushes publishing worktree-* branches), re-dispatched clean.
- Batch 2 launched in parallel: #782 (route presets, run `...ad6ee5d0`) + #807/#808 combo (finalize-run resilience, run `...585f0a8b`) — disjoint file surfaces, both codex, dispatch prompts now carry "COMMIT EARLY / budget the final gate" guidance from the A3 timeout lesson.
- Post-Phase-A main suite: relay-fleet shows 3-6 UNSTABLE failures (different tests each run — fan-out/SIGINT/review-resume timing family) while two codex dispatches hammer the machine; both A3 and #805 worktrees had relay-fleet green pre-merge. Verdict deferred to a quiet-machine rerun after the dispatches finish; if still red then, suspects are #810 paths.js × fleet child validation or #803×#811 dispatch.js interplay.

### 2026-07-06 (A3 + #805 parallel)
- First parallel dual-dispatch on merged A2 base: A3 (run `...b0d2faf2`, branch issue-781-a3) + #805 (run `...658ece28`, branch issue-805). File surfaces verified disjoint; #805's DC explicitly forbade touching A3's surfaces and vice versa.
- CORRECTION to earlier turns: "both dispatches killed at 25min" was a misread — rtk mangled `ps -p $p` chains into pager errors that looked like "gone". Both dispatches were alive the whole time. Lesson recorded: probe processes with plain `pgrep -f` or `rtk proxy`, never `ps -p N && echo` chains.
- #805 dispatch self-completed cleanly (commit 7ce143c, execution-evidence self-written) but landed `escalated`: dispatch auto-PR used manifest base_branch `worktree-floofy-seeking-music` — a local-only branch that never exists on origin. Filed as #809 (third linked-worktree defect after #805/#807/#808). PR #810 created manually with base main; recover-state escalated→review_pending --force; R1 PASS bull's-eye → `ready_to_merge`.
- A3 executor completed the implementation but timed out at 5400s before committing — final full-suite gate contended with THREE concurrent suite runs (its own + two orchestrator evidence runs; the orchestrator's premature "salvage" test runs, triggered by the rtk misread, likely ate its margin). Salvaged: orchestrator commit adc26ea, escalated→review_pending --force, PR #811 (base main), evidence from assembled orchestrator runs (dispatch 156/156, relay-review 432/432, remaining dirs green, SIGINT process-group contention flake passed isolated in both worktrees).
- A3 R1 CHANGES_REQUESTED on one finding: PR body claimed "pure additions" but 3 pre-existing JSON denial tests each gained one additive hint assertion. Fixed via gh pr edit + recover-state --allow-same-head --require-pr-body-change (first use of the PR-body-only same-HEAD recovery path). R2 LGTM, all DC VERIFIED → `ready_to_merge`.
- Both PRs stopped at ready_to_merge per protocol. Merging #811 completes Phase A and closes #781, unblocking Batch 2 (#782).

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
- 2026-07-20: Sprint closed. 15/16 tasks completed.
