---
milestone: Follow-up Quartet
status: completed
started: 2026-07-11
due: 2026-07-12
objectives: []
component: "fleet-reliability"
---

# follow-up-quartet

## Goal
Ship the four evidence-backed follow-ups from the closure-trio wave: supervisor terminal writes get a compare-and-swap (#926), drive liveness moves to the lease probe (#927), finalize-run gains a merge-time freshness gate (#929), and the drive surfaces stalled executors (#931).

## Plan

### Wave 1 — disjoint surfaces, fully parallel (3 leaves)

- [x] #926 — supervisor CAS guard. **MERGED** PR #937 (squash `372451c`), issue closed. Owner-approved DC amendment (relay-events.js additive registration); force-finalize after reviewer verified all correctness factors. 3 rebases past churn; validated 192/192 on combined head.
- [x] #927 — lease-probe liveness. **MERGED** PR #952 (`b786278`), issue closed. Salvaged from total_timeout; grok reviewer PASS (verified probe REUSE not copy-paste, all 4 factors). cursor-grok reviewer (codex quota out).
- [ ] #929 — merge-time freshness gate. IN PROGRESS (round 3): owner-approved **scope amendment** to use authoritative GitHub PR headRefOid (see Progress).

### Wave 2 — after #927 merges (same-file dependency: relay-fleet.js)

- [x] #931 — stalled_executor attention heuristic. **MERGED** PR #953 (`041ace3`), issue closed. cursor-grok executor+reviewer (codex quota out); R1 bull's-eye (all 4 factors PASS, verified reuses #927 lease probe, six-row matrix pinned). **fleet-quartet-w2 CLOSED.**

## Running Context — ALL PLANNER DECISIONS ARE MADE; DO NOT RE-LITIGATE

- **Artifacts are pre-authored** (DC + rubric + dispatch prompt per leaf, plus both leaves files) at `~/.craftkit/handoff/artifacts/dev-relay-quartet/` — durable, referenced by absolute path in the leaves files. #897 auto-persists each DC into the runDir at dispatch.
- Pre-made design calls (rationale recorded in each DC's planner note): #926 = fresh-read guard + existing `dispatch_result` event with `observed_state`/`intended_outcome` fields, NO enum member; #927 = `registryAlive || leaseIsLive`, single probe primitive shared with reconcile-run.js; #929 = overlapping-files strictness (any-behind rejected because batch=wave leaves are disjoint by convention; #914 overlapped on dispatch.js and is caught), refuse ≠ #845's dropped auto-rebase; #931 = stateless 0-byte heuristic (mid-run stalls accepted as undetected), depends on #927.
- **Executor route:** probe codex first (`codex exec --sandbox read-only --skip-git-repo-check -C /tmp 'Reply with exactly: ok'`); quota was exhausted twice on 2026-07-10 (last reset 23:31 KST). Fallback: `--executor cursor --model grok-4.5-high` (validated route; DNS-flap caveat: stderr connection-lost + 0-byte stdout = stalled, not slow). Reviewer: codex preferred, cursor fallback.
- **Run scripts from an up-to-date checkout** (origin/main tools worktree), not this workspace branch. Local `main` cannot fast-forward (another session's codex worktree holds it).
- **Drive invocation** (from the tools worktree; drive-by-default merges on LGTM — invoking relay-fleet IS the merge consent):
  `node <tools>/skills/relay-fleet/scripts/relay-fleet.js --repo /Users/sjlee/orca/workspaces/dev-relay/hydra --fleet-id fleet-quartet-w1 --leaves-file ~/.craftkit/handoff/artifacts/dev-relay-quartet/fleet-quartet-w1-leaves.json --executor <route> [--model ...] --reviewer <route> [--reviewer-model ...] --timeout 5400 --json`
  Keep the fleet-level `--timeout 5400`: #908 (open) makes redispatches drop per-leaf timeouts and fall back to 1800s otherwise.
- **Detach the drive from the harness** (cross-session bg-task kills, 3× on 2026-07-10): spawn via `node -e` with `{detached:true, stdio to a log fd}` + `unref()`; macOS has NO setsid. Watch fleet state with a Monitor polling `--status --json`. Verify liveness with a pgrep pattern that cannot match your own monitor cmdline.
- Known flakes (do NOT chase as regressions; evidence on #816): advisory settlement-deadline, gating-lane infrastructure, timeout-family dispatch tests under load. Rule: repeat a suspicious failure ≥3× per side, baseline origin/main at load <30 before blaming the leaf.
- Escalated-run recovery loop (validated repeatedly): `recover-state.js --to changes_requested --force --reason ...` → `dispatch.js --manifest <path> [--prompt-file ...] --executor ... --timeout 5400 --detach`. recover-commit operator evidence MUST be exit 0 (fail-closed by design).
- Sprint writes are orchestrator-single-writer; fleet children never touch `backlog/`.

## Progress

### ✅ COMPLETION SUMMARY (2026-07-12)

**All 4 issues shipped & closed; both fleets CLOSED.**

| Issue | PR | Rounds | Notes |
|---|---|---|---|
| #926 supervisor CAS | #937 (`372451c`) | R1 changes_requested → owner-amended | DC-vs-reality: fields can't persist without the forbidden `relay-events.js` allow-list registration; owner amended DC; force-finalized. 3 rebases past churn. |
| #927 lease-probe liveness | #952 (`b786278`) | R1 PASS | Executor total_timeout → recover-commit salvage; grok reviewer verified probe REUSE (not copy-paste). |
| #931 stalled_executor attention | #953 (`041ace3`) | R1 PASS | Wave 2. cursor-grok executor+reviewer; reuses #927 probe; six-row matrix. |
| #929 freshness gate | #940 (`30853dc`) | **R1–R3, 4 executor rounds** | prHead source odyssey: worktree-head → remote-tip → headRefOid (too invasive, broke placeholder-head fixtures across suites) → **owner reverted to remote-tip** (authoritative for relay's origin-only-branch-PR reality); force-finalized. |

**Incidents / lessons:**
- Environment was hostile all day: load whipsawed 13↔289 (other sessions), codex quota exhausted 2×, main advanced ~10 commits forcing repeated rebases (#926 rebased 3×, #929 several).
- Fleet **drive exited prematurely** both waves (hampered by the very registry-liveness bug #927 fixes) → drove manually via review-runner/finalize per child.
- **reconcile-run row 4** cleanly salvaged a killed-but-complete cursor run (#929 r2).
- **cursor grok** as executor: correct but slow & opaque (0-byte logs while working) — don't judge stall by log size; nearly mis-killed #929 r2.
- Two owner escalations (both DC/scope conflicts): #926 (amend) and #929 (revert). Original DCs left immutable; amendments recorded here + in finalize audit reasons.

**Follow-ups to file:**
- `tests/relay-merge/scripts/run-full-gate.test.js:81` "two invocations serialize…" — pre-existing concurrency flake (1-pass/2-fail on clean origin/main) → **#816**.
- headRefOid-vs-remote-tip freshness-gate design note: remote-tip shipped; headRefOid is the more-robust-but-invasive alternative (needs graceful-degradation or broad fixture seeding) → future hardening issue.

### 2026-07-11 — Wave 1 launched
- Executor route probed: **codex** alive (`gpt-5.6-sol`, exit 0) → executor+reviewer = codex. Cursor grok fallback not needed.
- Tools worktree created detached from origin/main `a8b72b3` at `/Users/sjlee/orca/workspaces/dev-relay/tools-quartet` (local `main` can't ff — another session holds it).
- Dry-run: `ok:true`, 3 children fanned out clean, no errors.
- Launched `fleet-quartet-w1` (#926/#927/#929) detached from harness (pid 41553), `--executor codex --reviewer codex --timeout 5400 --json`. All 3 children dispatched (issue-926/927/929, base `main`). Monitor armed on `--status --json`.
- Ambient load ~60 (13 users, other sessions' worktrees) — not leaked fixtures I own; will honor "baseline at load <30, repeat ≥3×" before blaming any flake.

### 2026-07-11 — Wave 1 all three escalated/blocked under load; salvage in progress
- **Environment:** ambient load hit 60; codex executors did their work but 2/3 hit `total_timeout` (0-byte stdout, work-stream in stderr). Drive (pid 41553) exited prematurely — hampered by the very bugs #926/#927 fix (registry-only liveness false-flagged review_pending #926 as `stuck_child`). Switched to **manual per-child driving** (review-runner → finalize), which avoids re-launching the drive into the #927 collision bug while #927's executor was still live.
- **#926** — executor finished, PR #937 (CI: test+CodeRabbit SUCCESS). Review preflight blocked: branch 2 commits behind origin/main (main advanced via other sessions' #925/#930). **DC-vs-reality conflict found:** DC §1/§2 require the `dispatch_result` event to persist `observed_state`/`intended_outcome`, but §3 forbids `relay-events.js` on the (false) premise "payload fields need none". Reality: `appendRunEvent` is a strict allow-list, no free-form passthrough; the #379 field the DC cites as precedent is itself registered there. Codex made the minimal 6-line additive registration (no enum member). **Escalated to user; decision = ACCEPT** (treat §3's relay-events.js bar as targeting enum changes, which is honored). Next: rebase → re-review → merge (merge still gated by clean review).
- **#927** — escalated `total_timeout` (5400s); complete uncommitted work in worktree fc8afe03 (relay-fleet.js +34, tests +215). Salvaging: full DC gate running detached → recover-commit → rebase (likely clean; relay-fleet.js not in behind-set) → re-review → merge.
- **#929** — escalated `total_timeout` (3600s); complete uncommitted work in worktree 187bc539 (finalize-run.js +142, tests +207, SKILL.md +7). relay-merge suite 207/207 green. Full DC gate running detached (317 ok / 0 fail, crawling under load). Salvaging: gate → recover-commit → rebase (SKILL.md overlaps #930) → re-review → merge.
- Full DC gates are slow/kill-prone under load; running them via detached node-spawn + sentinel (immune to cross-session harness-task kills). Load eased to ~28.

### 2026-07-11 — #926 DC amendment (OWNER-APPROVED) + reviewer confirmation
- **#926 review R1 (codex, against frozen DC):** `changes_requested`. Independent reviewer VERIFIED every correctness factor PASS (fresh-read state guard; superseded `dispatch_result` with observed_state/intended_outcome; lease removal; signal isolation; clean-success preservation; fixture PID reaping). **Sole blocker:** the relay-events.js forbidden-zone touch — reviewer explicitly stated *"If appendRunEvent's allowlist makes that impossible, the planner must amend the frozen scope before redispatch rather than silently expanding it."* This independently confirms the pre-merge escalation.
- **DC amendment (owner-approved 2026-07-11, "Amend DC & merge"):** relay-events.js — the minimal additive allowlist registration of `observed_state`/`intended_outcome` (mirroring the #379 `dispatch_failure_class` pattern) is **PERMITTED**; EVENTS enum member additions remain **FORBIDDEN** (none were added). Rationale: DC §1/§2 require the fields persisted to events.jsonl; appendRunEvent is a strict allowlist with no free-form passthrough; the #379 precedent the DC cited is itself allowlist-registered. Original done-criteria-926.md left immutable (amendment recorded here + in the finalize audit reason).
- **Merge mechanism:** review-runner has no `--rubric-file`, so the frozen rubric's "relay-events.js no diff" factor can't be cleanly amended for a re-review; per recovery-playbook (review-at-HEAD substantively passed, scope amended), merge via `finalize-run --force-finalize-nonready` with the amendment cited in the reason.
- **Moving-target rebases:** origin/main advanced 3× during the wave from other sessions (#930/#925/#920/#932). #932 (`a537510`) overlaps #926's dispatch.js `main()` region → rebased #926 to `f37a23a`, revalidating dispatch.test.js on the combined result before merge (#914 semantic-conflict guard).

### 2026-07-11 — Wave 1 salvage results
- **#926 (Accepted):** rebased clean onto origin/main (`e518d43`), force-pushed (PR #937 updated). dispatch.test.js on rebased tree = 191/192; the 1 fail (`timeout with commits produces completed-with-warning`) is a load flake — passed **3/3 at load 16** on the rebased branch (known timeout-family category, not a regression). Full DC gate running; CI pending on new head. Next: gate+CI green → re-review → merge.
- **#927:** full DC gate running clean (592/0). Next: recover-state→recover-commit→rebase(clean)→re-review→merge.
- **#929:** full DC gate = 1256/1260, **2 real failures** (not flakes): `pr-view-json-contract` — finalize-run's `gh pr view --json …headRefOid` isn't in `fake-gh.js` (which is OUTSIDE #929's allowed files). Chose the **in-scope fix** (source prHead via git/`manifestHeadShaFallback`, drop headRefOid) over widening scope to the fixture — DC-respecting, no amendment. Redispatched changes_requested with a targeted fix prompt (supervisor pid 30209, timeout 5400).

### 2026-07-11 (evening) — #929/#927 salvaged, cursor-grok reviewer (codex quota wall)
- **#929 redispatch fix WORKED:** committed "gate stale overlapping PRs" (PR #940); fix uses `extractLatestCommit` on a contract-supported field (not raw `gh pr view headRefOid`). Rebased clean onto main (`8132dd9`), evidence rebranded; pr-view-json-contract + relay-merge = 218/218. In review.
- **#927 salvaged:** full DC gate finally clean (1180/0 exit 0) at low load — earlier failures were timeout-family load flakes (each passed 3/3 targeted). recover-state escalated→review_pending → recover-commit (PR #952) → rebased clean (`3725a63`, relay-fleet.js no overlap) → evidence rebranded. In review.
- **Codex reviewer quota EXHAUSTED** ~18:47 KST (resets 20:01). Pivoted both reviews to **cursor grok-4.5-high** (blessed fallback; probe returned "ok"). Both reviews running.
- Environment note: main churned all afternoon then went quiet in the evening (load 60→13, main stable at a537510→372451c after #926); the low-load evening window is what let the gates finish clean. #926 required 3 rebases to beat the churn.

### 2026-07-11 (evening) — #926/#927 MERGED; wave 2 launched; #929 round-2 fix
- **#926 MERGED** (PR #937), **#927 MERGED** (PR #952). Wave 1: 2/3 closed.
- **#929 cursor review found a real correctness bug:** my in-scope fix sourced prHead from the WORKTREE head, but `gh pr merge` merges the REMOTE PR tip — so freshness ran against the wrong SHA when they diverge. Corrected guidance: source prHead from the remote tip via `git ls-remote`/`origin/<branch>` after fetch (in-scope, no `gh pr view headRefOid`, no fake-gh edit) + add worktree≠remote fixture. Redispatched round 2 with **cursor grok executor** (codex quota out). Lesson: when trading scope for an in-scope fix, check the fix isn't semantically wrong — the remote tip is what actually merges.
- **Wave 2 (#931) LAUNCHED:** #927 merged → dependency satisfied. fleet-quartet-w2 drive (pid 14993), cursor grok executor+reviewer, --timeout 5400. #931 dispatched. Worktree cut from main (has #927's lease-probe).

### 2026-07-11 (~20:00) — #931 MERGED, wave 2 CLOSED; #929 round-2 salvaged
- **#931 MERGED** (PR #953, `041ace3`), issue closed; **fleet-quartet-w2 CLOSED**. cursor grok executor delivered fast; grok reviewer R1 bull's-eye.
- **#929 round-2 cursor fix:** cursor implemented the CORRECT remote-tip fix (`resolveRemoteBranchHead` via `git ls-remote`, `evaluateMergeFreshness(prHead)` not `currentHeadSha`, +53 test lines) but ran ~67 min at 0-byte logs (cursor buffers — don't judge stall by log size alone). Codex quota reset → I SIGTERM'd my #929 supervisor (56575, mine only; reaped its cursor child; other sessions' cursors untouched). Work was uncommitted-but-complete → **reconcile-run row 4 salvaged it** (commit `6a48183` pushed to PR #940, evidence stamped, → review_pending). Validating gate; will review with codex (quota back). Lesson: cursor grok is slower/quieter than codex as executor; the reconcile-run row-4 salvage recovers a killed-but-complete run cleanly.

### 2026-07-11 (~21:30) — #929 round-3: OWNER-APPROVED scope amendment (authoritative headRefOid)
- **Pattern:** both reviewers (cursor R1, codex R2) insist the freshness gate use the **authoritative GitHub PR `headRefOid`** (the exact commit `gh pr merge` merges). Every in-scope workaround was flagged: worktree HEAD (R1: wrong SHA), remote branch tip via `git ls-remote` (R2: fork/non-origin/unfetched-object gaps). The authoritative `headRefOid` needs `gh pr view --json headRefOid`, which requires updating `fake-gh.js` — outside #929's original allowed files.
- **Owner decision (2026-07-11, "Widen scope + redispatch"):** amend #929's DC to allow `tests/relay-review/fixtures/fake-gh.js` (+ pr-view-json-contract test if needed) for headRefOid support; use the authoritative PR head; propagate it to merged manifest/audit metadata (codex P2); add non-origin-remote + lagging-worktree fixtures. Amended DC at `~/.craftkit`-adjacent scratch (done-criteria-929-amended.md); original left immutable. Redispatched round 3 with **codex** (supervisor 41014, quota reset). Review will pass `--done-criteria-file <amended>`.
- Environment: load whipsawed 13→289→13 through the evening from other sessions; #929 rounds paced around low-load windows.

### 2026-07-11 (~23:40) — #929 round 3 (codex) → round 4 (cursor); headRefOid landed
- **Round 3 (codex):** implemented authoritative headRefOid (finalize-run.js +45, fake-gh.js headRefOid field, non-origin+lagging fixtures) but escalated `no_result` before finishing; salvage found 2 sibling relay-merge tests failing `Cannot resolve authoritative headRefOid for PR #123` (their fixtures seeded an unresolvable placeholder head). Codex quota re-exhausted.
- **Round 4 (cursor grok, load ~4):** focused fix — seed resolvable headRefOid in the 2 sibling fixtures (finalize-run-learnings-guard + finalize-run.test), keeping finalize-run.js strict. Committed `5e1b7d4`, reached review_pending cleanly.
- **Round-4 gate = 1269/1272, 1 fail = PRE-EXISTING FLAKE:** `run-full-gate.test.js:81 "two invocations serialize and the second reports the live lock owner"` — a #930 lock-serialization test #929 doesn't touch. Baselined on CLEAN origin/main (041ace3): identical **1-pass/2-fail** pattern → concurrency flake, NOT a #929 regression. **→ log on #816.**
- Reviewing round-4 with cursor grok + `--done-criteria-file <amended>` (codex quota out); CI on #940 in progress. On LGTM + CI → merge → close fleet-quartet-w1.

### 2026-07-12 (~00:00) — #929 headRefOid proved too invasive → OWNER-APPROVED revert to remote-tip
- **CI on the round-4 headRefOid head went RED:** `tests/relay-plan/scripts/tdd-flavor.test.js` "mixed TDD rubric ... squash finalize" fails `git fetch origin aaaa...: not our ref` — the mandatory `git fetch origin <headRefOid>` breaks EVERY test that finalizes with a placeholder head, across suites the DC §3 gate doesn't cover. Whack-a-mole with more scope-widening each round; the round-4 cursor review also returned changes_requested.
- **Owner decision (2026-07-12, "Revert to remote-tip + merge"):** the round-2 `git ls-remote origin <branch>` fix is authoritative for relay's origin-only-PR reality (reviewers' fork/non-origin objection is out of relay's workflow) and was CI-green. Reset branch to the remote-tip commit `17cd34f` (dropped headRefOid `5e1b7d4`), rebased onto current main → `b5b778a` (clean; #949/#950 landed but no relay-merge overlap), evidence rebranded. Merging via **force-finalize** (reviewers won't pass the remote-tip over their out-of-workflow objection; owner override documented in the finalize reason). CI re-running.
- **Follow-up filed-worthy:** the headRefOid-vs-remote-tip tradeoff + the placeholder-head test invasiveness is a real design note for a future hardening pass. Also log run-full-gate.test.js:81 lock-serialization flake on #816.

### 2026-07-12 — RETRO + follow-up dogfood (/relay on #965)
Post-quartet retro reviewed all four shipped diffs. Confirmed the 30853dc (#929 merge) CI-red was the **known advisory-lane flake** (`persisted lane demotion cap`, review-runner-advisory.test.js:2602) — untouched by any quartet PR, 8/8 in isolation on clean origin/main; #816 datapoint logged. Main verified green (85e5ac2).

**Retro follow-ups filed:** #965 (freshness-gate graceful degradation — the actionable finding), #966 (headRefOid-vs-remote-tip hardening design note), #977 (reviewer-adapter internal-review `next_action` bug, discovered while dogfooding).

**#965 SHIPPED via /relay dogfood — MERGED PR #976 (`f22f4a9`), issue closed.** Arc:
- Plan authored inline (DC + 4-factor rubric + prompt); observability via finalize JSON `freshness` field only — deliberately avoided the #926 relay-events trap.
- Dispatch base = origin/main via #795 origin-fallback (stale local feature branch not on origin). **codex quota-walled at dispatch** (probe-echoes-then-walls) → recover-state → **cursor grok-4.5-high** executor delivered clean in-scope fix (`507e578`) in ~4 min; DC §3 gate 248/0.
- Review odyssey (hostile): cline = advisory-only (can't primary-review); **cursor grok returned correct PASS twice but the adapter rejected it** (`next_action=publish_pending` correct for internal, adapter demands `ready_to_merge` → #977); codex re-walled. Captured grok's real verdict, applied via `--review-file` (review-runner's own validation accepts `publish_pending`) → publish_pending → PR #976 → **post-pub grok review PASS** (`ready_to_merge` matches at post-pub, adapter bug is internal-only) → ready_to_merge → CI green → merged.
- **Live dogfood validation:** the merge's freshness gate fired `{behind_count:1, overlapping_files:[]}` — #968 landed disjoint between publish and merge; the #929 gate resolved the head and allowed it, exercising the #965 resolvable-head path in production.
- Lessons: (1) reviewer environment can block 3 different ways (advisory-only / adapter shape-bug / quota) — `--review-file` with a captured verdict is the escape hatch; (2) probe-echoes-then-walls means a codex probe "ok" does not guarantee the real call; (3) the reviewer-adapter `next_action` bug (#977) makes cursor unusable for *internal* primary review — real impact whenever codex is walled.
