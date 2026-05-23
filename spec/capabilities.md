# dev-relay Capabilities

The middle layer between [`CHARTER.md`](../CHARTER.md) (absent here — dev-relay has not opted into the reference axis yet) and the active sprint. Each block describes one subsystem-worth of work with a frozen-ish contract and a structurally bounded live-feedback channel.

**Status: strawman draft from brownfield grill (2026-05-23).** Produced by running `extract-signals.js` (from sibling repo `sungjunlee/dev-backlog`) against this repo, then regrouping the 8 by-skill-dir candidates into 6 functional capabilities. The maintainer should grill the structure — especially the cross-cutting `manifest-lifecycle` capability that extract-signals could not surface — before merging. Every Behavior and Hard Constraint here is a *proposal*; the 3-axis predicate test has not yet been walked interactively.

Mutation discipline matches `dev-backlog/docs/spec-system-design.md`: Goal/Scope/Behaviors/HardConstraints are human-gated via `backlog-charter grill`; `## Learnings` is appended only by `skills/relay-merge/scripts/append-learnings.js` between magic markers; `## Decisions` is append-only by convention.

| Section | Who writes | When | Gate |
|---|---|---|---|
| `Goal`, `In-scope`, `Out-of-scope` | human via `backlog-charter grill` | when the contract changes | challenge + confirm + apply |
| `Expected Behaviors`, `Hard Constraints` | human via grill | when a behavior or bright-line changes | grill + 3-axis predicate test |
| `## Learnings` (between markers) | `append-learnings.js` only | end of every successful relay run tagged for this capability | structurally bounded append |
| `## Decisions` | human, append-only | when a capability-level decision is made | append-only by convention |

---

## Capability: readiness-shaping

**Goal:** A user with an ambiguous task gets a stable leaf brief before any planning starts, so `relay-plan` has one task to plan, not an open question.

**In-scope:**
- `skills/relay-ready/` — readiness probe, bounded Q&A, leaf-brief persistence
- `~/.relay/requests/<repo-slug>/<request-id>/relay-ready/<leaf-id>.md` artifacts
- `--bypass-readiness --skip-readiness-reason <reason>` fast path

**Out-of-scope:**
- Rubric authoring (that's `planning`)
- Sub-task decomposition policy (relay-ready can split a request into multiple leaves; how each leaf is implemented is `planning` + `dispatch-execution`)

### Expected Behaviors
- A request that scores `bypass: true` on the route-stage preflight emits a leaf brief at `~/.relay/requests/<slug>/<id>/relay-ready/<leaf>.md` whose path is referenced by the downstream plan's `manifest.anchor.readiness` field.
- When the route preflight reports `readiness.bypass == false` and `prompt_allowed == true`, the orchestrator issues exactly one `AskUserQuestion` with the `signals_summary` text — never silently auto-bypasses.
- A non-interactive caller (no TTY) on a readiness-failing input emits `readiness_check_failed_nontty` event from the preflight payload and closes the run; it does not fall through to planning.

### Hard Constraints
- Never bypass readiness without a recorded `skip_reason` — operator override goes through the `--bypass-readiness --skip-readiness-reason <reason>` flag pair, never an implicit default.
- Never mutate the leaf brief after `manifest.anchor.readiness` is set — the brief is the immutable anchor for any later re-dispatch in the same run.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: planning

**Goal:** A task with explicit or inferred Done Criteria becomes a scored rubric and a dispatch prompt that a fresh-context reviewer can later score against without seeing the planner's reasoning.

**In-scope:**
- `skills/relay-plan/` — Done Criteria recovery, rubric authoring (S/M/L/XL by risk + ambiguity, not AC count), dispatch prompt generation, persisted Done Criteria
- `/tmp/dispatch-<N>.md`, `/tmp/rubric-<N>.yaml`, `/tmp/done-criteria-<N>.md` handoff artifacts
- `RUN_ID` allocation when Done Criteria persistence is required

**Out-of-scope:**
- Invoking the executor (that's `dispatch-execution`)
- Scoring the actual diff (that's `review-cycle`)
- Shaping ambiguous tasks before planning (that's `readiness-shaping`)

### Expected Behaviors
- Every dispatch prompt persisted to `/tmp/dispatch-<N>.md` includes a `<task-content source="done-criteria">` block — never inlines bare AC prose, because the source-marked block is what `review-cycle` extracts as its anchor.
- A persisted Done Criteria file at the planner-authored path is referenced from the dispatch handoff's `--done-criteria-file` flag; orchestrator code never re-derives Done Criteria from issue body at dispatch time when persistence ran.
- Every rubric YAML contains at least one factor with `weight: required` and at least one `prerequisites:` entry whose `target:` is `"exit 0"` — the prerequisite gate is structurally present, not optional prose.

### Hard Constraints
- Never invoke `relay-dispatch` from `relay-plan` — handoff artifacts only; the dispatch step is owned by `dispatch-execution`.
- Never re-issue a new `RUN_ID` mid-plan once one has been allocated and used in a persistence command; the same id must flow into the dispatch handoff.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: dispatch-execution

**Goal:** A planned task runs in worktree isolation against the chosen executor, commits land on a named branch, and the manifest reflects exactly what happened — no orphaned worktrees, no silent partial states.

**In-scope:**
- `skills/relay-dispatch/` — worktree creation under `~/.relay/worktrees/<short>/<repo>/`, executor invocation (Codex by default, Claude opt-in), commit-back guarantee
- `skills/relay-fleet/` — fan-out variant: parallel child dispatches under one fleet parent manifest; fleet status reporting; crashed-fleet resume
- Background dispatch with timeout + manifest event journaling

**Out-of-scope:**
- Authoring the dispatch prompt (that's `planning`)
- Reviewing the diff (that's `review-cycle`)
- Merging the PR (that's `merge-finalize`)

### Expected Behaviors
- A dispatch with `status: completed` and `runState: review_pending` always leaves at least one commit on the named branch; a dispatch that returns `completed` without any commit is structurally invalid and `dispatch.js` fails loud (does not silently advance the manifest).
- A timed-out dispatch emits `status: completed-with-warning` with `runState: review_pending` only when the worktree contains commits; otherwise it emits `status: failed` with `runState: escalated`.
- A fleet parent manifest references each child run-id; a child dispatch's manifest references its parent fleet id — both directions are present so a crashed fleet can be resumed from either end.

### Hard Constraints
- Never commit to the target repo's working tree directly — every dispatch runs in `~/.relay/worktrees/<short>/<repo>/`, isolated from the user's shell state.
- Never auto-merge or auto-push from `dispatch.js` — pushing the branch and opening the PR is the orchestrator's responsibility (and is idempotent if the executor also pushes); merging is `merge-finalize`'s.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: review-cycle

**Goal:** A PR is scored against its rubric in a forked context with no planning memory, and the LGTM that lands is tied to the specific commit SHA reviewed — so a later HEAD advance invalidates the gate.

**In-scope:**
- `skills/relay-review/` — fresh-context reviewer invocation, two-phase rubric scoring (Spec Compliance → Code Quality), re-dispatch on issues, manifest state advance, 20-round safety cap
- `skills/relay-sidecar/` — advisory artifact sidecars that produce reports without gating the merge
- `<!-- relay-review -->` and `<!-- relay-review-skip -->` PR comments as the audit trail

**Out-of-scope:**
- Authoring the rubric (that's `planning`)
- Merging the PR (that's `merge-finalize`)
- Triggering review with planning-side context (the whole point is fresh context — see Hard Constraint below)

### Expected Behaviors
- Every `<!-- relay-review -->` LGTM comment records the `head_sha` it was scored against in the manifest's `review.last_reviewed_sha`; a later commit that advances HEAD past that SHA invalidates the gate at merge-time (gate-check refuses with "stale LGTM").
- A review verdict of `CHANGES_REQUESTED` triggers a re-dispatch with the previous Score Log + reviewer feedback prepended; the original rubric anchor (Done Criteria) is never mutated across iterations.
- An advisory sidecar artifact is recorded in the manifest under a separate field from the merge-gating review; the presence or absence of a sidecar report never changes the `ready_to_merge` decision.

### Hard Constraints
- Never invoke the reviewer with the planner's session/context — review runs in a separately spawned process, anchored to the persisted rubric + Done Criteria, never to in-memory planner state.
- Never advance manifest state past `review_pending` without a comment on the PR that carries either `<!-- relay-review -->` (LGTM) or `<!-- relay-review-skip -->` (documented bypass reason). No silent state advances.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: merge-finalize

**Goal:** A reviewed PR lands, the worktree and branch are cleaned up, the linked issue is closed, and any cross-repo `spec/capabilities.md` gains a Learnings entry — all in one invocation, with state observable from the manifest.

**In-scope:**
- `skills/relay-merge/` — gate-check, finalize-run (merge + manifest advance + cleanup + branch delete), `append-learnings.js` cross-repo hook
- `manifest.cleanup` field (succeeded / failed / manual_cleanup_required)
- Sprint-file update conventions (`[~]` → `[x]` with PR ref, Progress log entry)

**Out-of-scope:**
- Deciding what to merge (that's `review-cycle`'s LGTM gate)
- Authoring the `spec/capabilities.md` target file in the downstream repo (that's `backlog-charter grill` in dev-backlog)
- Per-PR comments (separate concern — not yet captured as a capability here)

### Expected Behaviors
- `finalize-run.js` advances manifest state to `merged` only after GitHub reports the PR as `MERGED`; an API failure that leaves the PR in an in-between state is recorded under `result.merge` and the manifest stays at `ready_to_merge` for safe re-attempt.
- `append-learnings.js` runs after `STATES.MERGED` is set but before `runCleanup` — a failed cleanup is a worktree-state problem, not a "shouldn't have appended" problem; learnings entry is independent.
- `append-learnings.js` is idempotent on `run #<id>` substring: re-invocation against the same run-id returns `status: "skipped"`, `reason: "idempotent_match"`, and leaves the target file byte-identical.

### Hard Constraints
- Never merge a PR whose `review.last_reviewed_sha` does not match current HEAD — `gate-check` refuses with "stale LGTM" and re-review is required.
- Never write to `spec/capabilities.md` outside the `<!-- LEARN:BEGIN --> ... <!-- LEARN:END -->` markers, in any block other than the one matching the active sprint's `component:` — structural defense against adversarial Goodhart on the live-feedback channel.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: manifest-lifecycle

**Goal:** A relay run is auditable end-to-end from `~/.relay/runs/<repo-slug>/<run-id>.md` — every state transition, role binding, and policy decision is recorded immutably, and the state machine refuses invalid transitions.

**In-scope:**
- `~/.relay/runs/<repo-slug>/<run-id>.md` manifest schema
- State machine: `draft → dispatched → review_pending → ready_to_merge → merged`; `escalated → closed`; `changes_requested → dispatched` (re-dispatch)
- Role bindings (`roles.orchestrator`, `roles.executor`, `roles.reviewer`) — immutable after assignment; review-time overrides recorded under `review.last_reviewer` and `review_apply` events instead
- Event journal under the manifest

**Out-of-scope:**
- The specific work done in each state (those are the per-stage capabilities)
- Worktree filesystem state (that's `dispatch-execution`'s domain; the manifest only records paths)

### Expected Behaviors
- Every state transition that mutates `manifest.state` appends a corresponding event to the journal in the same write; a manifest whose `state` advanced without an event is structurally invalid and operator-emergency tools refuse to recover from it without `--force-finalize`.
- A review-time reviewer override mutates `review.last_reviewer` and emits a `review_apply` event with the acting reviewer name; it never mutates `roles.reviewer`, which is bound at manifest creation and immutable for the run.
- A `manifest.paths.worktree` value outside `~/.relay/worktrees/<short>/<repo>/` is rejected by `finalize-run.js`'s worktree-path guard — even for resumed runs.

### Hard Constraints
- Never mutate `roles.{orchestrator,executor,reviewer}` after manifest creation — role bindings are immutable for the lifetime of the run; the only sanctioned exception is the documented review-time `last_reviewer` field, which is a separate slot.
- Never advance manifest state out of `escalated` or `closed` back into an earlier state — terminal states are terminal; recovery is a new run that references the prior run-id.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |
