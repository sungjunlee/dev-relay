# Relay Runtime Architecture

The Relay runtime is an immutable-run system. It deliberately replaces the legacy
Markdown manifest, mutable lifecycle state, event journal vocabulary, rubric
sidecars, and executor-specific registration layer with one small durable
contract and a derived action.

This document describes the shipped Relay runtime. Files under
[`docs/archive/`](../docs/archive/) and dated plans are historical evidence,
not operator instructions.

## Contract vocabulary

Relay is **Git-required**: Git object identity is the content authority. It is
**forge-optional** at the architectural boundary: a forge supplies transport,
not a second content identity. The retained production route still uses GitHub
and its current lifecycle behavior is unchanged.

- **Source** is the Git repository plus immutable run start.
- **ReviewSubject** is the derived six-member content binding in
  [ADR-0007](../docs/decisions/0007-review-subject-contract-freeze.md), never a
  stored runtime object or fact.
- **Publication** places the exact revision on a remote ref. It is not Change
  Request creation and does not imply Landing; canonical recovery owns it.
- **Change Request** is the forge-owned PR/MR identity for a proposed revision.
  The retained route uses the exact GitHub PR and records or creates it
  separately from Publication.
- **Reviewed Result** is terminal proof of exact verification and independent
  review for one ReviewSubject. It does not imply Publication or Landing.
- **Landing** applies a reviewed revision to a target and independently observes
  the result; the current route performs Landing only through explicit
  `relay-merge`.

## Core model

```text
frozen input -> run.json + done-criteria.md
                     |
                     v
             append-only events.jsonl + external observations
                     |
                     v
                  inspect (derived action)
                     |
     dispatch / recover / review / explicit merge or close
```

There is no mutable state machine. `inspect` folds immutable facts together
with fresh Git, GitHub, host, and verification observations and returns one
typed next action. Writers re-inspect under the per-run lock and require the
same action key before they make a change.

The normal action sequence is `wait` -> `recover` -> `review` -> `merge`.
`redispatch`, `close`, `none`, and `operator_attention` are explicit terminal
or recovery outcomes, not hidden state transitions. Publication and Change
Request recording are recovery actions; dispatch never commits, pushes, opens a
PR, or recovers a run.

```text
relay-review
  -> ready_to_merge
  -> relay-merge (explicit only)
```

## Durable layout

Each Relay run is a directory below `~/.relay/runs/<repo-slug>/<run-id>/`:

| Artifact | Contract |
| --- | --- |
| `run.json` | Immutable version-3 identity: repository, worktree, branch, immutable executor/reviewer bindings, start SHA, and Done Criteria digest/path. |
| `done-criteria.md` | Frozen review anchor. The digest in `run.json` must match its exact bytes. |
| `events.jsonl` | Append-only, newline-delimited facts. Facts validate before append and are never rewritten. |
| attempt artifacts | Immutable prompt, stdout, stderr, result, and review/verification bundles bound by the attempt facts. |
| recovery and merge artifacts | Immutable intent, authorization, and receipt files used for crash-safe convergence. |

The eleven fact types are `attempt_started`, `attempt_finished`,
`attempt_interrupted`, `verification_recorded`, `lock_acquired`,
`lock_released`, `pull_request_recorded`, `review_recorded`,
`recovery_applied`, `merge_recorded`, and `run_closed`. They are the only
lifecycle evidence. There is no manifest mutation, lifecycle transition API,
execution-evidence sidecar, score log, route catalog, or app-registration
receipt.

## Operations

`dispatch.js` creates a new immutable run or appends a guarded attempt to a
run whose current action is exactly `redispatch`. It uses the universally
registered adapter descriptor and a thin local host. On macOS the host uses a
fail-closed `sandbox-exec` profile that gives the executor only its retained
worktree, exact declared inputs, exact output artifact, and attempt-private
temporary space. Unsupported local containment fails before writes.

`inspect.js` is pure folding logic. `recover.js` supplies the production
observer and the sole convergent mutation path. The public wrapper is:

```bash
node skills/relay/scripts/relay-recover.js inspect --repo . --run-id <id> --json
node skills/relay/scripts/relay-recover.js recover --repo . --run-id <id> \
  --reason "<why>" --expected-action-key <key> --json
```

Recovery alone may close a dead attempt, commit reviewable work, place a branch
revision on the remote ref (Publication), record/create the exact Change
Request, record verification, or append `run_closed`.
Every recovery step is authorized by a fresh action key and re-observed after
the side effect. An explicit close carries a durable operator and reason.

`review-runner.js` accepts only a run whose inspection says `review`. It derives
the ReviewSubject from the immutable Source, exact current Change Request head,
passed verification tree, current binary diff bytes, and frozen Done Criteria,
then binds the immutable reviewer into an isolated review bundle and appends one
`review_recorded` fact. A passing Reviewed Result is `lgtm`; it is terminal
proof of exact verification plus independent review and does not publish or
land the revision. Changes requested derive `redispatch`.

`gate-check.js` is read-only. `finalize-run.js` is the explicit merge writer:
it repeats inspection under the run lock, records an HMAC-bound
authorization tied to the authenticated GitHub login, uses GitHub's
expected-source-SHA guard, re-observes the exact merge, records one
`merge_recorded` fact, and only then removes a clean trusted worktree. GitHub
does not expose an expected-base CAS; the documented post-check/pre-request
base-retarget nanorace is a platform boundary, while source-SHA binding remains
strict.

## Adapters and host

The adapter platform is intentionally retained and universal. The seven
built-in executors are Claude, Codex, OpenCode, Pi, Antigravity, Cursor, and
Cline. Every descriptor lives in `scripts/adapters/` and is registered in
`adapters/index.js`; its four-method contract declares argv construction,
capabilities, output parsing, and metadata. Cline is dispatch-only until its
strict primary-review canary passes. No adapter owns manifest storage,
publication, app registration, or a private lifecycle.

The host owns only durable lock/ownership, detached supervisor launch,
terminal-result observation, bounded cancellation, stale-lock break, and
sandbox profile construction. It has no business lifecycle policy. The
authoritative signed close is published first and the single `lock_released`
outcome is materialized after it; a crash in between leaves no durable outcome,
and the next lock holder replays the canonical one exactly once.

Process containment is the cooperative `inherited_scope_no_daemon` contract:
supported CLIs must preserve the injected `RELAY_PROCESS_SCOPE` marker and must
not daemonize or clear it. `sandbox-exec` cannot prevent arbitrary `setsid` or
environment clearing, so the host revalidates the marker before every signal,
never signals an unverifiable process or group, and reports survivors as a
signed cleanup obligation. See the
[adapter platform](../skills/relay-dispatch/references/agent-adapter-platform.md)
for the full contract.

## Runtime size

There is one runtime. The installed dispatch package is the current filesystem
below `skills/relay-dispatch/scripts/`; no generated inventory or test ledger
duplicates that source of truth.

The Relay runtime is the only writer. Nothing admits a run, stamps a writer generation, or
translates retired argv, and retired manifests are not readable — the legacy
manifest reader went with the runtime reset. A repository that still holds
legacy state does not migrate; its historical runs stay unreadable and new
work starts as a Relay run.

## Trust boundaries

- `run.json`, Done Criteria, facts, and immutable artifact bytes are validated
  as regular contained files before use.
- Action keys bind the inspected snapshot and fresh observations; stale writers
  fail closed.
- Locks are capabilities with inode/owner checks and append durable acquire and
  release audit facts; each generation materializes exactly one release outcome,
  never before its authoritative signed close.
- Signals are bound to the inherited process-scope marker and revalidated
  immediately before delivery; unverifiable targets fail closed.
- Signed credential roots are removed by rename-to-quarantine and dev/ino
  revalidation; a swapped path is preserved as evidence, never deleted.
- External GitHub and merge observations use a fresh nonce-bound observer.
- PR comments, mutable files, prior prompts, executor transcripts, and legacy
  state are not authorities for Relay actions.

For command-level guidance see the [operator guide](../docs/relay-operator-guide.md),
the [adapter platform](../skills/relay-dispatch/references/agent-adapter-platform.md),
and the [recovery playbook](../skills/relay-dispatch/references/recovery-playbook.md).
