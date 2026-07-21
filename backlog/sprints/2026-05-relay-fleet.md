---
milestone: Sprint 2026-05 — relay-fleet Phase 1
status: completed
started: 2026-05-14
completed: 2026-05-15
epic: 481
---

# 2026-05 relay-fleet (Epic #481)

## Goal

Ship Phase 1 of the relay-fleet epic: a thin fleet layer over N independent relay runs that fans out dispatch in parallel without becoming a daemon and without redefining the per-run lifecycle. Target scale 2–5 concurrent runs. Surface Phase 2 prerequisites discovered during dogfood and scope #479 so Phase 2 can start cleanly.

Design boundary (per Epic #481 / `skills/relay-fleet/references/design.md`):
- Fleet is a **meta-UNIT**, not a meta-PR. Each child stays one normal PR with its own worktree, branch, frozen Done Criteria, rubric.
- Fleet manifest stores **dispatch intent only**, never per-run runtime state. Summary is derived on read.
- No daemon, no heartbeat, no LLM "fleet leader". Deterministic scripts only.
- Phase 1 ships fan-out + status. NO review orchestration (Phase 2 / #479). NO merge queue (Phase 3 / #480).

## Plan

### Phase 1 — fleet substrate + fan-out + status

- [x] **#477 Add relay fleet durable substrate (Sub-PR A)** — PR #482 / `41c2875` merged 2026-05-14 (codex+codex; 1 dispatch + 2 review rounds; R1 caught `updateFleetManifest` CRUD bypassing `validateTransition`, fixed `60fa2f2`).
  - Deliverables: new `skills/relay-dispatch/scripts/manifest/fleet.js` (fleet manifest CRUD + `validateTransition` 4-state machine `draft → dispatching → dispatched → closed` + `deriveFleetSummary` + `acquireIssueLock` / `releaseIssueLock` + `FleetIssueLockError` + `DISPATCH_STATUS` enum). `children[]` entries support nullable `run_id` for pre-manifest dispatch failures. `fleet_id` back-pointer added to `manifest/store.js` `createManifestSkeleton` (first write). `dispatch.js --fleet-id` wired through KNOWN_FLAGS + cli-schema + readArg + plan + skeleton call. `paths.js` gained `getFleetsBase` / `getFleetsDir` / `getFleetManifestPath` / `getFleetIssueLockPath` / `getFleetLocksDir` / `requireValidFleetId` / `listFleetManifestPaths`.

- [x] **#478 Implement relay-fleet skill (Sub-PR B)** — PR #483 / `4640658` merged 2026-05-14 (codex+codex; 1 dispatch + 2 review rounds; R1 caught `--status` text output rendering only aggregate counts not per-child list, fixed `b8ce573`).
  - Deliverables: new skill `skills/relay-fleet/` with SKILL.md (78 lines) + `scripts/relay-fleet.js` (832 lines) + `tests/relay-fleet/scripts/relay-fleet.test.js`. Subprocess fan-out per leaf artifact (NOT `require()`); each child invocation passes `--fleet-id`; per-child `acquireIssueLock` probe before spawn complements the per-child #408 in-flight check. `--resume` reconciles bidirectionally (orphan re-adopt by `fleet_id` back-pointer + pre-manifest cross-check + runtime PID guard). `--status` read-only, reuses `deriveFleetSummary`. SPOF documented. All 9 named tests from the issue body present.

### Phase 1.5 — Dogfood prerequisite cleanup

- [x] **#484 Fix relay-review fork-stall guidance** — PR #485 / `31f59d4` merged 2026-05-15 (codex+codex; 1 dispatch + 2 review rounds; R1 caught Step 4 check passing on a stale non-pending `latest_verdict` carried over from a prior round, fixed `f908dd7`).
  - Surfaced by Phase 1 dogfood (#478 R1): `relay-review` skill could fork, generate prompt + diff, then return with "now I'll wait for the background runner" while no runner was actually running — manifest sat at `state: review_pending`, `review.rounds: 0`, `latest_verdict: pending`. Recovered by invoking `review-runner.js` directly in foreground.
  - Deliverables: 8 +/- across two SKILL.md files. `skills/relay-review/SKILL.md` now forbids background/detached `review-runner.js` invocation and ties the fork's return to runner exit + `review-round-N-verdict.json` existing. `skills/relay/SKILL.md` Step 4 added a manifest-advanced check (compared against pre-review values, not the literal `pending`) + concrete foreground recovery before Step 5.
  - Hard prerequisite for Phase 2 (#479) — Phase 2 fans out N parallel reviews; a silently no-op'ing review step would multiply the failure mode.

### Phase 1 closeout — design record + Phase 2 scope

- [x] **Promote design plan into `skills/relay-fleet/references/design.md`** — `dfc83c9` direct-landed 2026-05-15 (doc-only, mirrors #456 precedent).
  - 212 lines covering Phase 1 rationale, rejected alternatives (fat/meta-PR, daemon, file-claim ledger, bisecting merge queue, dependency ordering), Phase 2/3 roadmap with codex outside-voice findings folded in (#1–#10), build sequence, test requirements, plan review provenance.
- [x] **Scope Phase 2 (#479)** — `fa68263` direct-landed 2026-05-15 (issue body rewrite + rationale comment + design.md status block).
  - Phase 1 dogfood gate dropped. Rationale: the dogfood signal worth waiting for (#484 / PR #485 — relay-review fork-stall) already surfaced and was resolved during Phase 1 work itself. Further fleet runs before scoping would produce no materially new evidence (`feedback_planning_void_overgeneration` cuts both ways).
  - New #479 body pins Done Criteria, 5 "what ships" items, 2 sub-PR build sequence, 9 tests, and out-of-scope list. Authoritative spec lives in the issue body; design.md § Phase 2 carries the why.

## Out of scope this sprint

- Phase 2 implementation (#479) — scoped, not started. Picks up in the next sprint.
- Phase 3 (#480) — still deferred; two hard prerequisites unfiled (per-run `ready_to_merge → merge_blocked` transition + stale-base recovery design).
- Visual board UI / kanban — `--status` text output is the only operator surface through Phase 2.
- LLM "fleet leader agent" — fleet is deterministic scripts.

## Running Context

### 2026-05-14 — #477 Sub-PR A merged (substrate)

- Probe: M-size; rubric design used `forbidden_zones` to protect every relay-dispatch sibling except the surface being touched (paths.js / store.js skeleton / dispatch.js flag wiring).
- Dispatch (codex executor, codex reviewer).
- R1 status `completed-uncommitted` → `recover-commit.js` → commit + PR #482.
- R1 review: `changes_requested` with 1 issue — `updateFleetManifest` CRUD helper bypassed `validateTransition`, letting callers reach `closed` directly. Real defect.
- R2 dispatch via `dispatch.js --manifest`; codex committed `60fa2f2` fixing the bypass + adding regression test.
- R2 review: PASS clean. All DC verified.
- `finalize-run.js --merge-method squash`; issue #477 auto-closed; no force-finalize.
- Lesson reinforced: state-machine bypass through CRUD helpers is recurring — the substrate must funnel mutations through `validateTransition`, never accept hand-written state assignments at the CRUD layer.

### 2026-05-14 — #478 Sub-PR B merged (skill)

- Probe: L-size; this is the user-facing skill on top of Sub-PR A's substrate.
- Dispatch (codex executor, codex reviewer).
- R1 status `completed-uncommitted` → `recover-commit.js` → commit + PR #483.
- R1 review: `changes_requested` with 1 issue — `--status` text output rendered only aggregate counts, missing the per-child list the DC enumerated. Spec was clear; implementation undershot.
- R2 dispatch via `dispatch.js --manifest`; codex committed `b8ce573` adding the per-child rendering + matching test.
- R2 review: PASS clean.
- **Dogfood surface bug**: `relay-review` skill's forked execution returned without invoking the runner ("Now I'll wait for the background runner" while no runner was running). Recovered manually by invoking `review-runner.js` in foreground. Filed as #484 same session.
- `finalize-run.js --merge-method squash`; issue #478 auto-closed; no force-finalize.

### 2026-05-15 — #484 fork-stall guidance shipped

- Decision: file as a narrow bug and ship BEFORE Phase 2 scoping. Phase 2 is fleet-scale review fan-out; building it on an intermittently-stalling review step would have multiplied the failure mode. Cost was low (M-size, doc-only, 2 review rounds, ~10 min wall clock).
- Considered: defer to a Phase 2 prerequisite checklist — rejected because the fix lives in two prompt-guidance files and is cheaper to do while context is hot.
- Probe: doc-only fix; rubric was concise — verify both SKILL.md files name foreground runner invocation + manifest-advanced check anchored to pre-review snapshot.
- Dispatch (codex executor, codex reviewer).
- R1 status `completed-uncommitted` → `recover-commit.js` → commit + PR #485.
- R1 review: `changes_requested` with 1 issue — the new Step 4 check compared against literal `pending`, which fails on a stale non-pending `latest_verdict` carried over from a prior round. Subtle but correct catch by reviewer.
- R2 dispatch via `dispatch.js --manifest`; codex committed `f908dd7` switching the check to "compared against pre-review snapshot" semantics.
- R2 review: PASS clean.
- `finalize-run.js --merge-method squash`; issue #484 auto-closed.
- Fix is **prompt-guidance only**, not a hard guarantee. Backstop in `feedback_relay_review_fork_stall` still applies — verify manifest actually advanced before declaring per-child review complete.

### 2026-05-15 — design.md promoted + #479 scoped

- design.md promotion: 212-line doc mirrored from `/tmp/relay-fleet-plan.md` into `skills/relay-fleet/references/design.md`. 1-line forward link added to relay-fleet SKILL.md. Direct-landed (no relay needed for doc-only changes per #456 precedent).
- #479 scoping decision: user asked to drop the Phase 1 dogfood gate. Decision recorded in three places:
  - #479 issue body (full spec — 5 ship items, 2 sub-PR sequence, 9 tests)
  - #479 rationale comment (gate-removal reasoning, `feedback_planning_void_overgeneration` reflection)
  - `skills/relay-fleet/references/design.md` § Phase 2 status block (timestamped 2026-05-15)
- No dispatch started this sprint — Phase 2 implementation moves to next sprint.

## Outstanding watch items

- **No fleet has been run yet end-to-end on real work.** Phase 1 was implemented + reviewed but the `relay-fleet` CLI itself hasn't dogfooded a 2–5 child fan-out. User decision (2026-05-15) was to skip the dogfood gate and scope Phase 2 directly off design.md + Phase 1 evidence. First real `relay-fleet --leaves-file ...` run will likely surface operational sharp edges (leaf JSON ergonomics, parallel codex quota interaction, `--resume` mid-flight reconciliation). Capture them in the next sprint's running context as they arise.
- **`relay-review` fork-stall fix is prompt-guidance only.** PR #485 tightened the SKILL.md narrative; the runner does not enforce foreground invocation programmatically. If Phase 2's parallel review fan-out exhibits the same intermittent stall under load, a hard guarantee may need to land before Phase 2 ships (e.g., relay-fleet must always invoke `review-runner.js` directly, never the `relay-review` skill).
- **Phase 3 (#480) two hard prerequisites still unfiled**: (a) per-run state-machine transition `ready_to_merge → merge_blocked` (`lifecycle.js` currently only allows `ready_to_merge → {merged, closed}`); (b) stale-base recovery design (after child N merges, child N+1's base is stale — Phase 3 must specify auto-rebase vs re-dispatch vs operator prompt). Surface as discrete issues only when Phase 2 lands and Phase 3 work is actually about to begin.
- **`--parallel` default is 4**. Soft cap, not a hard limit — `--parallel 8` or higher is fine when codex quota and worktree disk space allow. design.md's "target 2–5" is the operational sweet spot, not a system constraint.
- **Historical Phase 1 sprint-fleet wiring was advisory.** Issue #957 later enforced one ownership-bearing track per fleet before dispatch. Sprint files still do not auto-record fleet-id; if traceability matters for a given sprint, record fleet-ids in that sprint's Running Context section by hand.
