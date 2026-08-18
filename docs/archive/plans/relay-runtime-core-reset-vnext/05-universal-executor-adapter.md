Parent: #1129

## Outcome

Make executor diversity a stable platform capability while removing executor-specific lifecycle branching.

## Adapter contract

Each executor descriptor provides static metadata and exactly four methods:

1. `probe`
2. `capabilities`
3. `buildInvocation`
4. `parseOutcome`

Invocations are argv arrays only. Shell command strings are forbidden.

## Scope

- Migrate Codex, Claude, Cursor, OpenCode, Pi, Antigravity, and Cline.
- Share the same descriptor between dispatch and review where the executor supports both roles.
- Define capability negotiation and shared JSON/stdin/stdout protocols for future native adapters.
- Add transcript-based conformance fixtures.

## Acceptance criteria

- [ ] All seven currently supported executors remain available.
- [ ] Dispatch and review contain no branching on executor names.
- [ ] Every adapter passes the same probe, capability, invocation, outcome, quoting, timeout, and cancellation suite.
- [ ] No adapter or core path invokes a shell through an interpolated command string.
- [ ] Adding a future executor requires one descriptor file, fixtures, and registration only.
- [ ] Unsupported capabilities fail before worktree mutation with a precise error.

## Verification

- Golden argv and transcript fixtures for all adapters.
- Metacharacter and path-with-spaces tests.
- Dispatch/review role matrix and cancellation tests.

## Out of scope

- Reducing the number of supported executors.
- Choosing a preferred executor.

## Dependencies

- #1130
