Parent: #1129

## Outcome

Introduce the vNext immutable run record and append-only fact journal, with a pure lifecycle fold running in shadow mode beside the legacy manifest.

## Scope

- Add an immutable `run.json` identity record and a per-run append-only fact journal.
- Define closed, versioned payload schemas for lifecycle facts.
- Implement atomic fact append with one write, durability sync, and torn-tail quarantine.
- Implement a deterministic pure fold from `run + facts + live observations` to the next operator action.
- Emit shadow comparison results without changing production decisions.

## Acceptance criteria

- [ ] `run.json` identity and Done Criteria cannot be mutated after creation.
- [ ] Every fact type has a closed schema and unknown fields/types fail validation.
- [ ] Appends use exclusive ownership, append semantics, one encoded record per write, and durability sync before success.
- [ ] A partial final record is quarantined and reported; earlier valid facts remain readable.
- [ ] The fold implements the precedence table in the parent spec and is deterministic under replay.
- [ ] Shadow mode performs no vNext lifecycle writes other than comparison telemetry.
- [ ] Legacy and vNext decisions agree for 30 representative runs before cutover eligibility.

## Verification

- Property tests for replay determinism, duplicate delivery, event ordering, and terminal-state monotonicity.
- Fault injection at open/write/sync/rename/read boundaries.
- Golden fixtures for every event schema and derived action.

## Rollback

Disable shadow evaluation and continue using the untouched legacy manifest path.

## Dependencies

- #1130
