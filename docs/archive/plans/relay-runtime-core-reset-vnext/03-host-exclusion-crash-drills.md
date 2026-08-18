Parent: #1129

## Outcome

Replace PID/PGID/lease orchestration with the smallest durable host and exclusion contract that demonstrably survives launcher exit and crashes.

## Scope

- Specify and implement atomic per-run ownership acquisition and release.
- Define stale-owner detection using process identity plus durable attempt facts.
- Select the host primitive through a documented experiment rather than executor-specific assumptions.
- Keep current detach behavior available until the replacement passes all survival gates.

## Acceptance criteria

- [ ] At most one actor can append mutating facts for a run.
- [ ] A stale lock can be broken only after both owner liveness and recorded attempt state are revalidated.
- [ ] Worker completion is still observed after orchestrator/launcher exit in 20 consecutive trials.
- [ ] Ten injected crash points recover without duplicate dispatch, duplicate publication, or terminal-state reversal.
- [ ] Fifty concurrent acquisition trials produce exactly one owner each.
- [ ] Host selection and unsupported environments fail closed with an actionable `inspect` result.
- [ ] Legacy detach machinery is not removed until all gates pass.

## Verification

- Process-tree survival harness.
- Crash matrix around ownership, spawn, result capture, event append, and publication.
- Concurrency stress test in CI-compatible and local-host environments.

## Rollback

Retain and select the legacy detach implementation while preserving any already-written vNext facts.

## Dependencies

- #1130
