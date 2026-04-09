# Relay Intake Routing and Handoff Design

> Drafted 2026-04-09 to lock the implementation contract for #127, #128, #130, and #132 before coding begins.

## Summary

`/relay` remains the user-facing orchestrator.

`/relay-intake` becomes the standalone shaping skill for raw, ambiguous, or oversized requests.

`/relay` decides whether to bypass intake or invoke it, then always continues the normal downstream chain for relay-ready work.

## Decision

1. `relay-intake` is a standalone skill, not hidden state inside the run manifest lifecycle.
2. `/relay` stays the front door for full-cycle execution.
3. `/relay` may call `relay-intake`, but once a relay-ready contract exists the flow returns to the normal downstream path:

```text
relay-plan -> relay-dispatch -> relay-review -> relay-merge
```

4. The existing run manifest state machine remains execution-only. Intake owns preflight state and artifacts.
5. The issue-first fast path stays intact. Already relay-ready tasks should not pay extra intake overhead.

## Control Flow

```text
input to /relay
   |
   +-- relay-ready already?
   |      |
   |      +-- yes --> relay-plan
   |                   -> relay-dispatch
   |                   -> relay-review
   |                   -> relay-merge (explicit only)
   |
   +-- no --> relay-intake
               -> classify / clarify / propose / structure
               -> write request artifact + event log
               -> produce one or more relay-ready leaf contracts
               -> return control to /relay
                        |
                        +-- single leaf --> normal downstream chain
                        |
                        +-- multiple leaves --> one normal relay cycle per leaf
```

## Routing Rules

`/relay` may bypass `relay-intake` only when all of the following are true:

1. The input already describes one relay-sized task.
2. The task has a stable review anchor already available.
3. No clarification, proposal, or decomposition work is needed.

If any of those conditions are false, `/relay` must invoke `relay-intake`.

### Source-type hints

These are hints, not overrides:

| Input shape | Default route | Why |
| --- | --- | --- |
| GitHub issue number with actionable AC | Bypass candidate | Often already relay-ready |
| Local task file with explicit AC | Bypass candidate | Already normalized input |
| Free-form text request | Intake | Needs shaping |
| Epic, sprint, or multi-step request | Intake | Needs decomposition |
| Any request without stable Done Criteria | Intake | Review anchor must be created first |

An issue number is not an automatic bypass. If the issue is broad, mixed-scope, or missing a trustworthy review anchor, `/relay` should still route through intake.

## Relay-Ready Contract

A request becomes relay-ready only at the leaf-task level.

Each relay-ready leaf contract must include at least:

- `request_id`
- `leaf_id`
- `title`
- `goal`
- `in_scope`
- `out_of_scope`
- `assumptions`
- `done_criteria_path`
- `escalation_conditions`

Recommended normalized shape:

```yaml
request_id: req-20260409-001
leaf_id: leaf-01
title: Fix login redirect loop
goal: Stop authenticated users from being redirected back to /login
in_scope:
  - Update the redirect guard
  - Cover the authenticated and unauthenticated paths
out_of_scope:
  - Redesigning the login page
assumptions:
  - Session state remains cookie-based
done_criteria_path: ~/.relay/requests/<repo-slug>/<request-id>/done-criteria/leaf-01.md
escalation_conditions:
  - Session state source is unclear
  - Existing auth flow depends on undocumented side effects
```

The exact file naming can evolve, but intake must persist:

- one request artifact
- one append-only request event log
- one normalized handoff brief per relay-ready leaf task
- one frozen Done Criteria snapshot per relay-ready leaf task

## Downstream Handoff

### `relay-intake`

Owns:

- classify / clarify / propose / structure
- request artifact persistence
- portable interaction protocol
- decomposition into leaf tasks
- frozen Done Criteria snapshots for non-issue inputs

Does not own:

- rubric design
- run manifest creation
- dispatch execution
- review execution

### `/relay`

Owns:

- deciding fast path vs intake path
- resuming from a relay-ready contract without re-running clarification
- selecting which relay-ready leaf task to send downstream
- continuing the normal chain after intake succeeds

Does not own:

- a second, duplicate readiness classifier
- interactive questioning after handoff

### `relay-plan`

Reads the normalized handoff brief, not the raw request, and produces the rubric plus dispatch prompt.

### `relay-dispatch`

Creates the run manifest and records linkage back to intake, for example:

- `source.request_id`
- `anchor.done_criteria_path`

### `relay-review`

Reviews against the frozen Done Criteria snapshot, not against executor-authored PR prose.

## Multiple Leaf Tasks

`relay-intake` may return multiple relay-ready leaf tasks from one parent request.

That does not create a second execution system. It creates multiple normal relay runs.

Batching and ordering remain orchestrator concerns in `/relay`, not intake concerns.

## Interaction Protocol

The core protocol must work in both Claude and Codex without relying on host-specific widgets.

Rules:

- proposal-first by default
- one question at a time
- max 1-3 turns before either handoff or close/escalate
- `A/B/C + free text` must always be sufficient
- buttons or cards are optional adapters, not correctness requirements

## Consequences

### Good

- Keeps the run manifest clean and execution-focused
- Preserves the current issue-first fast path
- Makes free-form and oversized requests first-class without polluting dispatch/review
- Gives non-issue work a trustworthy review anchor

### Bad

- Adds one more skill and one more routing branch
- Requires `/relay` to own a clear fast-path decision

### Mitigation

- Keep the public model simple: `/relay` is the front door, `/relay-intake` is the shaping tool
- Keep the routing rule explicit and documented
- Keep intake output normalized so downstream skills do not need special cases
