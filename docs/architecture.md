# Relay Runtime Architecture

The Relay runtime is an immutable-run system. It uses one small durable
contract, append-only facts, and a derived action instead of mutable lifecycle
state, rubric sidecars, or executor-specific registration layers.

This document describes the shipped Relay runtime. Finished designs live in
git history, not a second documentation tree.

## Contract vocabulary

Relay is **Git-required**: Git object identity is the content authority. It is
**forge-optional** at the architectural boundary: a forge supplies transport,
not a second content identity. The retained production route still uses GitHub
and its current lifecycle behavior is unchanged.

- **Source** is the Git repository plus immutable run start.
- **ReviewSubject** is the derived six-member content binding in
  [ADR-0007](./decisions/0007-review-subject-contract-freeze.md), never a
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

There is no mutable state machine. A new run requires frozen Done Criteria, or
a rubric used as that anchor; there is no grandfather bypass. The public source
gate first classifies the checkout: no configured remotes selects local
Reviewed Result delivery, while an identity-matching GitHub origin selects the
retained PR route. Unsupported remotes fail before execution. `inspect` then
folds immutable facts together with fresh Git, GitHub, host, and verification
observations and returns one typed next action. Writers re-inspect under the
per-run lock and require the same action key before they make a change.

A recorded GitHub PR binds through `{pr_number, repo, head_ref, base_ref}`.
After `merge_recorded`, the last `pull_request_recorded.head_sha` need not
equal the live MERGED `pr_head_sha`.

The GitHub action sequence is `wait` -> `recover` -> `review` -> `merge`; the
local sequence is `wait` -> `recover` -> `review` -> `recover` for terminal
Reviewed Result closure. `redispatch`, `close`, `none`, and
`operator_attention` are explicit terminal or recovery outcomes, not hidden
state transitions. GitHub Publication and Change Request recording are
recovery actions; local closure is also recovery-owned. Dispatch never commits,
pushes, opens a PR, or recovers a run.

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

The twelve fact types are `attempt_started`, `attempt_finished`,
`attempt_interrupted`, `verification_recorded`, `lock_acquired`,
`lock_released`, `pull_request_recorded`, `review_recorded`,
`review_escalation_resolved`,
`recovery_applied`, `merge_recorded`, and `run_closed`. They are the only
lifecycle evidence. There is no mutable lifecycle record, transition API,
execution-evidence sidecar, score log, route catalog, or app-registration
receipt.

## Operations

`dispatch.js` creates a new immutable run or appends a guarded attempt to a
run whose current action is exactly `redispatch`. It uses the universally
registered adapter descriptor and a thin local host. The host launches the
argv directly on the trusted local machine on every supported OS. An adapter
may request its own native filesystem control; missing or declaration-only
control is a foreground diagnostic, not an admission failure. This is not a
hostile-worker boundary: a direct CLI may read other files the local user can
read.

`inspect.js` is pure folding logic. `recover.js` supplies the production
observer and the sole convergent mutation path. The public wrapper is:

```bash
node skills/relay/scripts/relay-recover.js inspect --repo . --run-id <id> --json
node skills/relay/scripts/relay-recover.js recover --repo . --run-id <id> \
  --reason "<why>" --expected-action-key <key> --json
```

Recovery alone may close a dead attempt, commit reviewable work, place a GitHub
branch revision on the remote ref (Publication), record/create the exact
Change Request, record verification, or append the local Reviewed Result's
`run_closed` fact. When inspection already derives a merged terminal, recover
skips GitHub and remote observation and may remove a clean registered worktree
at the recorded `pr_head_sha` through `cleanup-worktree.js`. Dirty,
HEAD-changed, unregistered, mismatched, or canonical checkouts are retained;
removal is never `--force`.

Measurement (2026-08-15): canonical recovery is also the routine publication
and verification conveyor, not only crash machinery. Across recent vNext runs,
219 of 228 `recovery_applied` events (96%) served the routine conveyor —
`verification_stale` (104), `publication_incomplete` (80),
`verification_missing` (35) — while the crash rule `attempt_liveness_unknown`
fired in 8 of 52 runs (15.4%). Crash convergence is a real but measured small
subset of recovery work.

Every recovery step is authorized by a fresh action key and re-observed after
the side effect. An explicit close carries a durable operator and reason.

`review-runner.js` accepts only a run whose inspection says `review`. It derives
the ReviewSubject from the immutable Source, the exact current GitHub Change
Request head or fresh local Git head, passed verification tree, current binary
diff bytes, and frozen Done Criteria, then binds the immutable reviewer into a
contained staged-input bundle and appends one `review_recorded` fact. The
direct reviewer process is not filesystem-confined by Relay, but Relay binds
the exact staged paths and revalidates them after the process exits. A passing
Reviewed Result is `lgtm`; it is terminal proof of exact verification plus
independent review and does not publish or land the revision. Changes requested
derive `redispatch`.

`gate-check.js` is read-only. `finalize-run.js` is the explicit merge writer:
it repeats inspection under the run lock, records a durable merge
authorization bound to `--actor` (default `git user.name`; it does not call
GitHub REST `/user`), uses GitHub's expected-source-SHA guard, re-observes the
exact merge, records one `merge_recorded` fact, and then removes a clean
trusted worktree through the same `cleanup-worktree.js` helper. GitHub does not
expose an expected-base CAS; the documented post-check/pre-request
base-retarget nanorace is a platform boundary, while source-SHA binding remains
strict.

## Adapters and host

The adapter capability contract is intentionally retained and universal. The seven
built-in executors are Claude, Codex, OpenCode, Pi, Antigravity, Cursor, and
Cline. Every descriptor lives in `scripts/adapters/` and is registered in
`adapters/index.js`; its four-method contract declares argv construction,
capabilities, output parsing, and metadata. Cline is dispatch-only until its
structured primary-review output contract is registered. No adapter owns run storage,
publication, app registration, or a private lifecycle.

The host owns only durable lock/ownership, detached supervisor launch,
terminal-result observation, bounded cancellation, stale-lock break, and
runtime executable binding. It has no business lifecycle policy. The
authoritative signed close is published first and the single `lock_released`
outcome is materialized after it; a crash in between leaves no durable outcome,
and the next lock holder replays the canonical one exactly once.

Process containment is the cooperative `inherited_scope_no_daemon` contract:
supported CLIs must preserve the injected `RELAY_PROCESS_SCOPE` marker and must
not daemonize or clear it. The host revalidates the marker before every signal,
never signals an unverifiable process or group, and reports survivors as a
signed cleanup obligation. See the
[adapter platform](../skills/relay-dispatch/references/agent-adapter-platform.md)
for the full contract.

## Runtime size

There is one runtime. The installed dispatch package is the current filesystem
below `skills/relay-dispatch/scripts/`, including `run-store.js` and
`adapters/`. No generated inventory or test ledger duplicates that source of
truth. Phase skills import this core; they do not own a second lifecycle.

Install the complete bundle (`npx skills add sungjunlee/dev-relay`). Set
`RELAY_SKILL_ROOT` to the installed sibling root when invoking commands
outside this repository; it defaults to `skills` in a clone.

The Relay runtime is the only writer. Nothing admits a run, stamps a writer
generation, or translates retired argv. Retired run artifacts are not readable;
a repository that still holds retired state does not migrate, and new work
starts as a Relay run.

## Trust boundaries

- `run.json`, Done Criteria, facts, and immutable artifact bytes are validated
  as regular contained files before use.
- Review receives a direct, contained staged diff/prompt/criteria/schema path,
  never an executor transcript; a staging mutation, drift, or containment
  violation fails typed before ordinary runtime escalation and appends no fact.
- Action keys bind the inspected snapshot and fresh observations; stale writers
  fail closed.
- Locks are capabilities with inode/owner checks and append durable acquire and
  release audit facts; each generation materializes exactly one release outcome,
  never before its authoritative signed close.
- Signals are bound to the inherited process-scope marker and revalidated
  immediately before delivery; unverifiable targets fail closed.
- Signed staged review-input roots are removed by rename-to-quarantine and
  dev/ino revalidation; a swapped path is preserved as evidence, never deleted.
- External GitHub and merge observations use a fresh nonce-bound observer only
  on the GitHub route; local delivery has no forge observation.
- PR comments, mutable files, prior prompts, executor transcripts, and legacy
  state are not authorities for Relay actions.

For command-level guidance see the [operator guide](./relay-operator-guide.md),
the [adapter platform](../skills/relay-dispatch/references/agent-adapter-platform.md),
and the [recovery playbook](../skills/relay-dispatch/references/recovery-playbook.md).
