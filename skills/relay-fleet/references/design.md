# relay-fleet design

> **Status (2026-05-14):** Phase 1 shipped — Sub-PR A (#477, PR #482) and Sub-PR B
> (#478, PR #483) are merged. Phase 2 (#479) and Phase 3 (#480) remain deferred.
> This document is the design record behind Epic #481: the rationale, rejected
> alternatives, non-goals, and phase boundaries. The authoritative per-phase
> contract lives in the GitHub issues; this doc explains *why*.

## Problem

`/relay` today processes exactly one PR per cycle (plan → dispatch → review → merge).
When a user has N independent issues, they must invoke `/relay` N times serially,
even though dispatch is the long pole and the work is independent.

## Goal

Add a thin fleet layer above individual relay runs that fans out dispatch across
N runs in parallel — WITHOUT becoming a daemon or a service, and WITHOUT
redefining the relay cycle. Target scale: 2-5 concurrent runs, not 20-30.

## The unit: meta-UNIT, not meta-PR

The fleet is a coordination wrapper over N **normal** PRs. PR semantics do not
change: each subject = a normal-sized PR, with its own worktree, branch, frozen
Done Criteria, and rubric. A "fat/meta-PR" bundling multiple subjects is rejected
— it breaks the per-run rubric model, kills fan-out parallelism (two executors
can't share one branch), and defeats atomic revert. The fleet is the meta-unit;
the PRs stay ordinary.

## Phased delivery (re-sequenced per codex outside-voice)

The original plan called itself a "thin wrapper" but secretly redefined half of
`/relay` — it specified fan-out + merge while leaving review orchestration blank.
Re-sequenced so each phase ships with zero blank states:

- **Phase 1** — fleet manifest + fan-out dispatch + status aggregation. NO merge,
  NO review orchestration. Ships the parallel-dispatch value immediately.
- **Phase 2** — review orchestration loop (run relay-review per child until each
  reaches `ready_to_merge`).
- **Phase 3** — serialized merge queue.

## Non-goals

- No visual kanban board (consume an existing one — Vibe Kanban etc. — or emit a
  static status view from `reliability-report`).
- No background coordinator / heartbeat / watcher chain (Gas Town's daemon model
  rejected — it turns the project into a service to operate).
- No LLM "fleet leader agent" — the leader is deterministic scripts only. This is
  WHY Phase 1 input is already-planned leaf artifacts, not raw issue numbers
  (see Phase 1.2).
- No file-claim ledger / cross-PR file conflict detector — worktree isolation
  prevents mid-flight collision; the Phase 3 merge queue catches the rest at
  merge time.
- No bisecting / batch-test merge queue — at N=2-5 it buys ~1 test run and needs
  net-new local-test infra. Plain serialized queue (Phase 3).
- No children-dependency ordering. Independent subjects (the common monorepo
  case: separate frontend + backend improvements) need none. Interdependent
  subjects either stay one normal run, or wait for a later dependency-ordering
  phase. Separate axis from serialized-vs-parallel merge.

## Prior-art grounding (from research)

- **Claude Agent Teams**: session-parallelism primitive, file-based coordination,
  NO merge strategy, one-team-at-a-time. Wrong altitude to copy.
- **Gas Town + Beads**: dev-relay independently converged on its two hardest
  theses (acceptance-criteria-over-scripts; "sessions are cattle, agents are
  pets"). Genuine gap is fleet altitude. Gas Town's daemon/watcher hierarchy and
  Dolt-backed index are 20-30-agent answers to problems dev-relay does not have.
- **Kanban tools (Vibe Kanban / Conductor / Composio)**: worktree-per-agent-per-PR,
  human-supervised merge. Board UI is commoditized — do not rebuild it.

## Phase 1: fleet manifest + fan-out dispatch + status aggregation

### 1.1 Fleet manifest — `~/.relay/fleets/<repo-slug>/<fleet-id>.md`

Pure index + fleet-level state. Holds EXACTLY:
`{fleet_id, fleet_state, children[], timestamps}` where each `children[]` entry is
`{leaf_ref, run_id|null, dispatch_status}`. Critically `run_id` is nullable: a
child whose dispatch failed BEFORE a run manifest was written (worktree creation,
base merge, prompt/rubric validation failure) has `run_id: null` +
`dispatch_status: dispatch_failed_pre_manifest`. The fleet tracks dispatch
*intent*, not just successful runs — otherwise pre-manifest failures are
invisible to both `children[]` and any back-pointer scan. (Codex #5.)

Every per-child *runtime* fact (state, review status) is still read through the
child run manifest in `~/.relay/runs/` — the fleet manifest never duplicates it.

- `fleet_state`: `draft → dispatching → dispatched → closed`. Deliberately simple.
  Phase 1 has no `reviewing`/`merging` because Phase 1 does not review or merge.
- **Fleet summary is computed, not stored.** `fleet_state` is a coarse lifecycle
  marker; the real picture (3 children dispatched, 1 escalated, 1
  pre-manifest-failed) is a *derived summary* over `children[]` + child manifests.
  Phase 1 must specify the summary computation rules explicitly — partial state
  is the norm with N runs, not an exception. (Codex #7.)
- Transitions go through a `validateTransition` equivalent in a new
  `manifest/fleet.js`, mirroring `manifest/lifecycle.js`. Direct state assignment
  is a bug.
- No index structure. At N=2-5, iterating `children[]` + `readManifest` is
  microseconds.

### 1.2 Fan-out dispatch — new `relay-fleet` skill / CLI

- **Input is already-planned leaf artifacts, NOT raw issue numbers.** `dispatch.js`
  requires a prepared prompt + rubric + Done Criteria. A deterministic fleet
  script cannot generate those (that is relay-plan's LLM work). So the fleet CLI
  takes a list of leaf contracts already produced by relay-ready/relay-plan. The
  fleet does fan-out, not planning. (Codex #1, #2.)
- Invokes existing `dispatch.js` **as a subprocess** once per leaf (not
  `require()` — subprocess gives per-child crash isolation and avoids coupling to
  dispatch.js's 1445-line internals).
- Each child runs in its own worktree. Reuses the #408 in-flight run check per
  child.
- **`dispatch.js --fleet-id <id>` is part of Phase 1, Sub-PR A** — the `fleet_id`
  back-pointer must be written into the child run manifest at its FIRST write
  (skeleton creation in `store.js`), not bolted on later. Splitting schema (A)
  from wiring (B) would leave the crash-safe contract half-built. (Codex #4.)
- **Crash-safe ordering**: child run manifest carries `fleet_id` at first write;
  resume reconciles bidirectionally — `relay-fleet --fleet-id <id> --resume`
  scans `~/.relay/runs/` for orphan children pointing back at this fleet AND
  cross-checks `children[]` for pre-manifest failures.
- **Fleet-level issue lock / preflight reservation.** The per-child #408 check
  reads the manifest list; two fleets dispatching the same issue near-
  simultaneously can both pass before either manifest exists. Phase 1 adds a
  fleet-level reservation (lock file or reservation entry) taken before
  subprocess spawn. (Codex #6.)
- Dispatch is parallel (worker-side, quota-friendly per
  `feedback_prefer_codex_heavy_workflow`).

### 1.3 Status aggregation

`relay-fleet --fleet-id <id> --status` computes and prints the derived summary
(per §1.1): per-child state, dispatch failures, escalations, what needs operator
attention. Read-only. This is the Phase 1 substitute for review/merge
orchestration — the operator sees the picture and drives review/merge by hand
with existing per-run tools until Phase 2/3 land.

## Phase 2: review orchestration loop (deferred)

Run `relay-review` per child until each reaches `ready_to_merge` or escalates.
Adds `reviewing` to `fleet_state`. Scoped from Phase 1 dogfood.

> Phase 2 prerequisite surfaced by the Phase 1 dogfood: #484 — `relay-review`'s
> forked execution can return before the review actually completes, leaving a
> child silently stalled at `review_pending`. A parallel fan-out of forked
> reviews must not be built on a review step that can no-op silently.

## Phase 3: serialized merge queue (deferred)

Merge children one at a time via `finalize-run.js`. Two hard prerequisites the
original plan missed:
- **New per-run transition `ready_to_merge → merge_blocked`** (or a `merge_blocked`
  event model). `lifecycle.js` currently allows only `ready_to_merge → {merged,
  closed}` — "kick the child back to changes_requested" is an INVALID transition
  as the state machine stands. (Codex #3.)
- **Stale-base recovery design.** After child N merges, child N+1's base is stale.
  `finalize-run.js` checks the review gate + failing CI but does NOT auto-rebase
  or re-dispatch. The serialized queue *detects* the failed merge but Phase 3
  must design what *recovers* it (auto-rebase? re-dispatch? operator prompt?).
  (Codex #8.)

## Resolved questions

1. Markdown manifest vs real index → no index, iterate `children[]`.
2. Merge queue batching → N/A, no batching (bisect cut).
3. Fleet ↔ dev-backlog sprint files → one fleet per sprint batch is the natural
   mapping; wire opportunistically.
4. Stalled-child detection without a daemon → resume re-scans children via
   `fleet_id` back-pointer + `children[]` cross-check. No daemon.
5. Phase 1 size → 2 sub-PRs (see build sequence).

## Build sequence — Phase 1 (2 sub-PRs)

- **Sub-PR A**: `manifest/fleet.js` (fleet manifest schema with nullable-`run_id`
  `children[]` entries + `fleet.js` state machine) + `fleet_id` back-pointer field
  written by `store.js` skeleton creation + `dispatch.js --fleet-id` flag +
  fleet-level issue lock. Tests: CRUD, every state transition pair, back-pointer
  written at first manifest write, lock blocks concurrent same-issue dispatch.
- **Sub-PR B**: `relay-fleet` skill + fan-out (subprocess wiring) +
  resume/reconcile + status aggregation. Depends on A. Tests below.
- Sequential: B depends on A. (Phase 3's merge queue is NOT independent of B —
  it needs the same fleet runtime model B builds; it is correctly deferred to its
  own phase, not parallelized.) (Codex #9.)

### Phase 1 test requirements (codex #10 folded in)

- duplicate issue listed twice in the same fleet
- two fleets racing the same issue (lock holds)
- child dispatch fails BEFORE manifest creation (`children[]` records
  `dispatch_failed_pre_manifest`, recoverable)
- fan-out partial failure: `dispatch.js` fails on child 3/5, fleet manifest
  stays consistent
- **REGRESSION-CLASS (critical)**: resume re-adopts orphan child via `fleet_id`
  back-pointer
- SIGINT during fan-out → fleet manifest consistent, resume recovers
- resume while a child subprocess is still running (no double-dispatch)
- `relay-fleet --dry-run` end-to-end
- status aggregation derived-summary correctness across mixed child states

## Plan review provenance

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES_RESOLVED | 10 findings — all folded; drove Phase 1 re-sequencing |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_RESOLVED | 6 issues, 1 critical gap — all folded into plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **Step 0 scope**: REDUCED twice — (1) bisecting merge queue → plain serialized; fat/meta-PR rejected. (2) Phase 1 re-sequenced per codex: merge → Phase 3, review orchestration → Phase 2, Phase 1 = fan-out + status only.
- **Eng review (6)**: A fleet state machine enforcement, B subprocess vs require, C orphan-worktree race, D SPOF disclosure, E manifest contract, F no-index — all folded.
- **Codex outside-voice (10)**: #1/#2 review orchestration hole + input-contract contradiction (input = leaf artifacts), #3 invalid `ready_to_merge → changes_requested` transition (real plan bug — caught with lifecycle.js open), #4 `fleet_id` at first write → `dispatch.js --fleet-id` in Sub-PR A, #5 pre-manifest dispatch failure → nullable `run_id` in `children[]`, #6 fleet-level issue lock, #7 derived fleet summary rules, #8 stale-base recovery (Phase 3 prereq), #9 merge queue not independent of fan-out (→ own phase), #10 test list — all folded.
- **CROSS-MODEL**: codex extended the eng review rather than contradicting it. One tension (Phase 1 scope) resolved in codex's favor — user chose the re-sequencing.
