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

- [~] #784 relay-config inspect: opencode/pi model-list probes time out (ETIMEDOUT at 5s) — S, ~1 relay run; independent of the phase chain, good parallel candidate alongside #781
- [~] #781 Routes single concept: unified routes.json, open-by-default posture, strict opt-in (Phase A) — L; split as A1 loader/gate/posture/event/ADR → A2 relay-config vocabulary → A3 friction wiring + doc banners; A1 dispatched

### Batch 2 — per-run UX (blocked by #781)

- [ ] #782 Route presets: --route-preset, /relay natural-language mapping, model catalog (Phase B) — M

### Batch 3 — self-audit (blocked by #781)

- [ ] #783 relay-config revise mode: gaps --json, conversational amendments, migrate (Phase C) — M; degrades gracefully without #782 (preset_broken gap type inert until presets exist)

### Unplanned (found during Batch 1 execution)

- [~] #786 close-run cannot close runs whose worktree was pruned by dispatch signal cleanup — S; part 1 ready_to_merge (PR #789, R3 PASS); part 2 (dispatch.js signal stamping) deferred until #781 A1 merges
- [ ] #795 dispatch branches from local main; unpushed local commits contaminate every PR diff — filed after the same scope-noise finding cost one review round on each of PR #789/#791/#792 (rule of three)

## Running Context

- Design reference: `docs/route-config-simplification-design.md`. Dependency chain: #781 → #782 → #783; #784 independent.
- Posture flip is a shipped-behavior change: no-config default goes fail-closed → open. Legacy `policy.json` holders keep current semantics until migrated (#781 loading order). ADR 0007 required in the #781 PR.
- `evaluateRelayRoute()` must stay unchanged — routes config maps to the policy-shaped object in memory. No derived policy.json file (drift is the disease being treated).
- `UNREGISTERED_ROUTE_USED` goes into the frozen EVENTS enum with write-time validation coverage (#313 pattern); consumers are #783 gaps and reliability-report.
- SKILL.md prose is pinned by sibling test suites (PR #746 incident): every phase that rewords SKILL.md runs the FULL repo suite.
- relay-config is a wrapper (skills/relay-config) delegating to a core script (skills/relay-dispatch/scripts/relay-config.js): vocabulary rename lands in both; `allow-route` alias kept one release.
- Phase D (relay-plan route recommendation + fleet per-leaf fill) is NOT in this sprint — observe-gated on ≥~10 non-default-route runs over ~4 weeks after A–C ship.

## Progress

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
