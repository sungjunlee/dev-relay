# relay-orca — SUPERSEDED / FROZEN

**Status:** frozen 2026-07-24. Not maintained. Do not use, invoke, or extend.
**Why kept:** reference tombstone. The code and tests still pass and are left in place so the
principles it proved (and the machinery it disproved) stay readable. New work goes to the
successor, not here.

## What it was

An experimental, explicit-only **program-altitude coordinator**: it compiled an already-accepted
epic/program contract into bounded Orca "waves" that supervised ordinary `relay` / `relay-fleet`
operators, with integration gates and evidence-backed completion. Milestone #12, epic #941.

## Why it was retired

It worked, but it was the wrong shape for where this project is going:

- **Heavy for its added value.** ~10k lines of JS + 345 tests — comparable to `relay-review`, 3× `relay-fleet` — to add three things over `relay-fleet`: cross-wave persistent supervision, integration gates, and a human-intervention message channel.
- **Single-layer by design; the opposite of the goal.** The contract explicitly forbids nested relay-orca and raw-intent decomposition (epic #941 invariants). The direction this project actually wants is *deep decomposition* — which relay-orca structurally cannot do.
- **Coupled supervision to orchestration.** That coupling is what made it heavy: a runtime-session-bound receipt, a coordinator-provenance contract, a live supervision loop.
- **Only just reached end-to-end against the real CLI.** The 2026-07-22 closure re-pilot never declared completion reset-free (two Orca app restarts stranded the receipt — #1063), and the #1019 gate lifecycle did not run against real Orca until #1067. Both were fixed 2026-07-23, and that clean-close is exactly why it can be frozen now rather than left ambiguous.

## Principles it PROVED — carry these into the successor (non-negotiable)

1. **Evidence over signals.** Never trust `worker_done` / task status; declare completion only from durable truth (relay manifests, merged PRs, closed issues). This is what survived two runtime restarts.
2. **Frozen anchors are the review contract.** An immutable Done-Criteria anchor per unit of work is what let reviews converge instead of drift.
3. **Fail closed on ambiguity.** When state is unclear, stop — never advance.
4. **Audited state transitions.** Every state change carries a reason; no silent edits.

## Machinery it DISPROVED — do NOT reuse

- A bespoke supervised control plane that reimplements orchestration on top of a runtime.
- Binding durable identity to a runtime/session id (see #1063).
- A one-layer supervision ceiling with nesting forbidden.
- A coordinator-provenance contract inferred from CLI payloads (see #1067).

## Successor direction (see project CLAUDE.md / memory)

**Decompose deep, execute flat.** A cheap decomposition tree with no per-node lifecycle; ordinary
`relay` runs only at the leaves; parents are a recursive *evidence fold* ("done = all children
done-with-durable-evidence"), not a state machine. No new runtime, no session coupling. The human
(or a thin planning pass) stays the decomposer for now; raw-intent autonomous decomposition is
deferred. Successor skill: to be created.

## Shipped history (for archaeology)

Children #942–#948 shipped; closure arc #1016/#1018/#1019/#1020/#1021; Batch-5 re-pilot verdict
ITERATE (epic #941 closed 2026-07-23); iteration set #1063/#1064/#1066/#1067 merged. Full journal:
`~/.relay/closure-941-20260722/pilot-journal.md`.
