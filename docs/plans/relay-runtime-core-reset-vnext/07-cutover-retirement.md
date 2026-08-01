Parent: #1129

## Outcome

Cut over active relay runs safely, rewrite dispatch around the vNext core, and retire the legacy runtime after measured compatibility gates.

## Migration policy

- Use drain-and-cutover when there are at most five active legacy runs and the oldest is under 72 hours.
- Otherwise use dual-read/vNext-write.
- Never rewrite terminal historical runs.
- Remove compatibility shims only after zero active legacy runs and zero legacy reads for both 30 days and 30 vNext runs, using whichever threshold completes later.

## Scope

- Implement explicit legacy-to-vNext read mapping and a runtime-generation marker.
- Rewrite dispatch as a thin orchestration path over run creation, ownership, executor invocation, fact append, and action derivation.
- Cut over review and merge readers after shadow parity and crash gates pass.
- Remove legacy manifest mutation, old recovery implementations, and migration shims at the final gate.

## Acceptance criteria

- [ ] Migration choice is computed from observed active-run count and age and is recorded as a fact.
- [ ] Active legacy runs finish without history rewriting or identity changes.
- [ ] New runs write vNext only after all prerequisite gates are green.
- [ ] A rollback overlay can return readers to legacy without deleting vNext facts.
- [ ] Dispatch, review, recovery, and merge all consume the same derived lifecycle action.
- [ ] Old recovery implementations and mutable state transitions are deleted after the retirement threshold.
- [ ] Final installed `relay-dispatch/scripts` contains 14–18 JavaScript files and 4,000–6,000 production LOC, excluding tests, docs, fixtures, and expired migration shims.
- [ ] All seven current executors pass conformance and available live canaries.
- [ ] The full serialized relay suite and package-content checks pass.

## Dependencies

- #1131
- #1132
- #1133
- #1134
- #1135

## Out of scope

- Removing executor diversity.
- Rewriting terminal historical records.
- Adding new workflow policy layers during migration.
