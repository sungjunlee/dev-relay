---
milestone: Fleet Closure Trio
status: completed
started: 2026-07-10
due: TBD
objectives: []
component: "fleet-reliability"
---

# fleet-closure-trio

## Goal
Ship the three evidence-backed finishing issues from the 2026-07-10 post-sprint closure review: the dispatch supervisor stops tripping on lingering notifiers (#899), the opencode advisory lane's yield is root-caused and restored (#900), and the fleet drive says WHY a child is stuck (#901).

## Plan

### Batch 1 — disjoint surfaces, fully parallel (3 leaves)

- [x] #899 — MERGED (PR #913) + issue closed 2026-07-10, cursor R1 PASS after DNS-stall resume. The defect it fixes reproduced LIVE mid-wave on #900's run (zombie supervisor stale-overwrote review_pending).
- [x] #900 — CLOSED via STOP path (PR #903 closed, no code delta). Mechanism identified from the OpenCode session DB: glm-5.2 finished every message `finish:"tool-calls"` with zero text parts → opencode exit 0 + empty stdout. 2/2 live real-bundle replays now succeed; issue closed not-reproducible with a reopen protocol (preserve bundle + raw-response + session id).
- [x] #901 — MERGED (PR #916) + issue closed 2026-07-10, cursor R1 PASS bull's-eye (reviewer explicitly verified the DC-amended relay-events whitelist entry). Salvage path: orchestrator commit → rebase onto post-#915 main → gate v3 green → recover-commit (--replace-placeholder-evidence).

## Running Context

- Executor AND reviewer: cursor/grok-4.5-high (codex quota exhausted; route validated 2026-07-10 on recovery-finalize-polish). cline/glm-5.2 available as bench.
- Scripts run from the origin/main tools worktree (scratchpad/relay-tools) — #897 (DC persist at dispatch) and #890 (amendment-aware redispatch prompts) are needed.
- Planner probes for #900 (2026-07-10): piped-small OK, piped-10KB-filler OK — excluded hypotheses recorded in the DC; real suspect is bundle content (glm-5.2 empty completion).
- #899 changes the contract pinned at dispatch.test.js ~L5338 — deliberate re-scope, timeout path stays byte-preserved.
- Sprint writes are orchestrator-single-writer; fleet children never touch `backlog/`.

## Progress

### 2026-07-10 (planned + wave 1 launched)
- Fleet: fleet-closure-trio-w1, 3 leaves, leaves file /tmp/fleet-closure-trio-w1-leaves.json (DC anchors auto-persisted to runDirs at dispatch via #897).

### 2026-07-10 (wave 1 mid-flight: timeouts, resumes, new findings)
- Drive killed twice as a harness background task (cross-session shared tasks dir) → relaunched via node `detached: true` spawn, immune since. macOS has no `setsid`; a pgrep liveness check matched the MONITOR's own cmdline (rtk two-signal rule again).
- #901 run 1: total_timeout 3600s mid-tests. Salvage: DC AMENDMENT (planner overspec — relay-events.js payload serialization whitelist REQUIRES a `next_action` entry; enum still frozen) + resume with prior work preserved (+327 lines) and 5400s.
- #899 run 1: total_timeout 5400s under load-94 machine contention (concurrent sessions). Resume with budget-disciplined prompt (test-name-pattern iteration, gate once).
- #900: R1 codex changes_requested (5 issues — DC's diagnosis-first teeth worked: missing verbatim repro transcript, Branch B without pre-fix replay, no live-yield evidence, wait-for-check scope creep, no SHA-bound gate evidence). Drive auto-redispatched but at the 1800s DEFAULT — leaf timeout dropped by buildRedispatchArgs → escalated; recovered manually with --timeout 5400. **Filed #908** (redispatch drops per-leaf timeout) with this run's event evidence.
- Adjacent observation (not yet filed): `buildOperatorAttention`/redispatch guard use the drive's runtime REGISTRY for liveness, so an operator-resumed run shows `stuck_child` while alive by lease — same family as #876's registry-vs-lease distinction. Assess after #901 lands (its enrichment reduces the noise cost).
- 13:45 live race (ISSUE CANDIDATE, file post-wave): #900's zombie supervisor (12:15 + 5400s ceiling) fired `dispatch_result total_timeout` AFTER the run had been published and its round-2 review invoked — stale `dispatched→escalated` overwrote `review_pending` mid-review. Distinct from #899's DC (leader never exited here): the supervisor's terminal transition lacks a compare-and-swap against the CURRENT manifest state. Recovered with audited `--to review_pending`.
- Environment log: codex quota exhausted 2nd time (resets 23:31 KST) killing both codex resumes instantly → returned to cursor; Tailscale MagicDNS flapping confirmed as the executor-stall root cause; load peaked 178.
- 13:47: #899 ready_to_merge (cursor R1 PASS on the resumed work); merged + issue closed by the drive shortly after.

### 2026-07-10/11 (main-red discovery + hotfix #915; #900 STOP closure)
- #901's salvage gate exposed **origin/main red**: 8 #883-arc tests + skills-lint reachability, deterministic at low load in two checkouts (the rest of the gate failures were load-178 flakes — all pass on baseline). Filed **#914**.
- Root cause: #890 (#883 amendment→prompt refresh) × #897 (#882 DC persisted to runDir, anchor re-pointed) merged 4 minutes apart, each green on its own base. #913 (#899's PR) adapted the tests to amend the runDir copy — suite green, but the documented operator amendment flow stayed silently broken and resume-passed amendments diverged executor prompts from reviewer anchors.
- **Hotfix PR #915 MERGED**: resume re-persists the runDir copy from the live original (original = single amendment surface; wiped original degrades to the copy); #883 tests amend the original again; anchor-missing split into re-create/proceed-from-copy/both-missing-fail pins. Plus skills-lint fix: wait-for-check.js (#840/PR #895) had zero doc references → documented in recovery-playbook.md. Guards: #883|#914 13/13, full dispatch.test.js + review-runner.test.js exit 0, skills-lint 24/24.
- recover-commit fail-closed validation (operator evidence must be exit 0) is what forced fixing main first — the tooling worked as designed.
- Process gaps observed: (a) near-simultaneous merges of same-file PRs need a cross-check gate; (b) #840's leaf gate lacked skills-lint so the missing doc shipped; (c) #913 absorbed test adaptations outside its DC scope without a planner check.

### 2026-07-11 (SPRINT COMPLETE — fleet closed 3/3)
- #901 MERGED (PR #916), issue closed, cursor R1 PASS bull's-eye. Fleet `fleet-closure-trio-w1` reached `closed` (899 merged / 900 closed-STOP / 901 merged).
- Flake bisect coda: gate v2's `on_pass advisory settlement deadline` failure looked like a #913/#915 regression (3 consecutive fails) but proved a pre-existing flake (4/10 targeted fails across both sides of the merge) — evidence logged on #816. Gate v3 green at load 8 → recover-commit evidence exit 0.
- Net new issues from this sprint: #908 (redispatch drops leaf timeout), #914 (main-red, FIXED by PR #915), plus #816/#899 evidence comments.
- Post-sprint follow-up quartet filed 2026-07-11: #926 (supervisor terminal-transition compare-and-swap), #927 (drive liveness via lease probe, not registry), #929 (merge-time freshness gate, design decision points in body), #931 (stalled_executor attention, visibility-only). NOT filed by design: opencode session-id capture (await recurrence), nightly canary (#929 is the structural fix), quota classification (no consumer).
