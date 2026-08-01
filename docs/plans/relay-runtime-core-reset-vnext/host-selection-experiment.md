# Host selection experiment

This records the shadow-only `local_supervisor` experiment for #1131. It does
not change production dispatch selection. The host accepts argv and has no
executor-specific branch.

## Decision

Use an OS-reparented detached session for the vNext local supervisor. Do not
create one launchd service per attempt.

Node starts the supervisor with `detached: true`, closed standard streams, and
`unref()`. On POSIX this creates an independent process group/session. The
launcher waits only for an authenticated ready artifact and can then exit. The
supervisor opens attempt logs, starts the executor in its own process group,
and atomically publishes an authenticated terminal result. Timeout and
cancellation send `SIGTERM`, wait a bounded grace period, then send `SIGKILL`
to the process group.

An exclusive launch claim reserves the attempt namespace before config bytes
are written. Authenticated supervisor-claim and ready artifacts bind the
attempt, logical handle, config digest, supervisor PID, observable process
start time, kernel process-group identity, command telemetry, and a per-launch
birth nonce. The stable comparison key is PID + non-null kernel start time +
PGID; PPID and command hash are retained for reparenting and invocation audit,
not treated as stable identity. The launcher accepts ready only when
both artifacts, the spawned PID, config digest, nonce, and lock-token-derived
HMAC match. Pre-existing artifacts and attempt-id reuse fail before config
overwrite.

On current macOS the start time comes from `ps lstart` and has one-second
resolution, so the persisted fingerprint is a bounded, best-effort
re-identification aid rather than an OS process handle. Destructive group
signals additionally require the supervisor's original `ChildProcess` anchor
to remain open; after its close event, PID reuse cannot trigger a signal and
the attempt stays non-terminal for inspection. A future durable broker may
replace this with a stronger kernel handle.

The supervisor publishes ready only after writing an authenticated executor
identity artifact containing PID, process group, and observable process start
time plus a signed birth nonce. If the supervisor dies, liveness checks that executor identity and
refuses stale breaking while the executor is live or its identity cannot be
disproved. A missing executor artifact after authenticated ready is unknown,
never stale. When a launch claim exists, a missing ready artifact probes the
authenticated executor identity if available and otherwise remains unknown.
The lock owner's PID is used only when no launch claim exists, proving that
spawn was never reserved.

Startup does not rely on a bare fixed file timeout. The launcher observes the
ready artifact, supervisor PID/start liveness, and a dedicated startup-stderr
artifact for up to a bounded 30-second deadline. A supervisor claim conflict is
an explicit error rather than a silent exit. Startup failures include attempt
ID, PID/start identity, ready and stderr paths, stderr tail, elapsed time, and
the last liveness observation so a volume-test failure identifies the exact
attempt. Structured supervisor failures write cancellation first, wait a
bounded window for in-flight executor identity publication, and then abort
identity-bound supervisor and executor groups. Ordinary diagnostic banners do not turn a successful
handshake into an abandoned launch.

## Rejected candidate: per-attempt launchd jobs

The first experiment used a unique `launchctl submit` label per attempt. It
passed short 20/20 survival runs, but repeated top-level suites eventually made
both new and previously used labels fail with status 1 and empty stderr.
`launchctl bootstrap` also failed with I/O error in the same login session.
At that point `gui/501` reported 463 services, while no `dev.relay` label was
live. Waiting and globally pacing submissions did not restore registration.

This is a structural failure, not a retry-policy problem: per-attempt label
churn consumes a process-external namespace/resource that is not reliably
reclaimed during a long login session. Green tests after login or machine
restart would hide the failure. The implementation therefore removes the
per-attempt launchd submit, cleanup, pacing, and gate machinery.

A single long-lived broker remains a possible future host when stronger
reboot/session semantics are required. It is not needed for the current
contract, and adding its queue and recovery protocol would be unjustified
complexity while detached sessions satisfy the measured gates.

## Exclusion and stale-owner contract

Per-run exclusion is an immutable generation ledger under `ownership/`.
Contenders publish a complete `NNNNNNNNNNNN.owner.json` through a temporary
owner-only file and atomic hard-link (`O_EXCL` semantics). The lowest unresolved
generation is the owner. Colliding contenders retry the same next generation;
once one publication wins, all others observe it as held. Owner paths are
never renamed, overwritten, reused, or deleted.

Release and stale recovery race to publish the same immutable
`NNNNNNNNNNNN.terminal.json` path with outcome `released` or `broken`, so
exactly one terminal decision can win. Legacy split markers are authenticated
when read and any dual-terminal history fails closed. A capability remains
bound to generation, exact owner inode, token, and bytes. After election, only
the capability that issued the exact decision may finish its audit. The
generation remains unresolved until an authenticated
`NNNNNNNNNNNN.terminal-audit.json` binds that audit completion to the exact
terminal-record digest. There is no
fixed mutable lock pathname, directory guard, transition file, or partial
release state, removing their ABA and partial-write recovery protocols. Stale
breaking requires:

- fresh canonical attempt facts and a run-bound Git observation;
- an authenticated terminal result, or two internally issued dead PID/start
  probes at least ten seconds apart;
- final owner-byte and worktree revalidation immediately before mutation.

The broken terminal record authenticates its evidence and worktree digests.
Release and break first elect their mutually exclusive terminal decision, then
append or check the canonical audit, and finally publish the immutable
audit-completion marker. An audit failure therefore leaves one elected outcome
pending and safely retryable with the same issued evidence; the opposite
outcome cannot append its audit after losing the election. If the issuing
process exits in that window, `resumePendingTerminal()` reconstructs a
decision-scoped capability from the immutable owner and authenticated decision,
replays only that outcome's deterministic `audit_key`, and publishes the
completion marker. Audit sinks must therefore deduplicate that key: recovery is
at-least-once for one elected outcome, never exactly-once across the journal and
ledger files. A release decision persists whether an external audit is
required. Fresh-process recovery cannot close a required decision without a
sink acknowledgment containing the exact `audit_key` and
`durable: true, idempotent: true`; a callback-free resume fails closed.
The canonical fact journal implements that acknowledgment as event-id
put-if-absent semantics: byte-identical retries coalesce to one logical fact,
while the same event ID with different content invalidates the journal. Broken
recovery derives a stable timestamp from the elected terminal decision, so
concurrent retries are identical rather than merely similar.
An unknown process identity may be recovered only with the single
authenticated terminal-result proof; liveness proofs remain unavailable from
unknown observations.

Every run, cwd, config, claim, log, ready, cancel, and result path is checked
against its canonical trusted root. Mutable attempt files must be direct
children of the run directory, and cwd must equal the pinned worktree root.
Traversal, symlink components, outside paths, unsafe attempt IDs, and unsafe
host handles fail closed.

Bare command names remain intentionally supported for installed executor CLIs
and resolve through the supervisor's inherited `PATH`; artifact and worktree
paths, not executable lookup, are the canonicalized trust boundary.

## Measured gates

On macOS, the detached-session candidate passed:

- 20/20 worker completions after launcher exit, with distinct authenticated
  receipts, logical host handles, result bytes, and completion markers;
- 100 additional sequential detached attempts with `gui/<uid>` launchd
  `service count` non-increasing and zero added `dev.relay` labels;
- 50 concurrent independent lock contenders with exactly one owner;
- ten injected crash points across lock audit, attempt start, spawn, result,
  attempt finish, and publication, with one execution, one publication, one
  terminal close, and idempotent recovery;
- spawn-error authentication, forged ready/result/executor rejection, release
  immutable-generation election, startup-window executor recovery, and bounded
  descendant cleanup while a kernel-verified group leader remains. If a normal
  exit leaves descendants after that identity anchor disappears, or if
  TERM/KILL identity verification fails, no terminal result is published and
  inspection is required.

The complete five-file gate then passed in four separate top-level Node
processes: 17/17 each in 70.9s, 57.3s, 56.4s, and 75.6s. Each process ended
with zero matching supervisor or worker orphans. Every run included both the
20-trial launcher-exit gate and the 100-attempt zero-launchd-growth gate.

After an independent back-to-back run exposed one opaque pre-ready timeout,
the liveness/error-aware startup protocol above replaced the file-only wait.
The 100-attempt gate then passed four fresh top-level processes in succession:
100/100 each in 64.4s, 94.4s, 191.7s, and 60.7s under varying host load.

The final complete gate, including the startup-diagnostic regression, passed
18/18 under sustained host contention. The run took 1,070.6s; notably, the
20-trial gate took 357.2s and the 100-attempt gate took 485.9s without a ready
loss. Git-backed stale observations use bounded 10-second identity and
30-second content deadlines so they still fail closed without confusing normal
process-start pressure with stale-owner evidence.

The selection gate accepts only an in-process capability minted from at least
20 internally verified launcher-exit outcomes. Arbitrary JSON, repeated
outcomes, duplicate handles, and duplicate result hashes are rejected.

That in-process capability is deliberately an experiment gate. Production
selection will require a durable, re-verifiable attestation bound to host,
primitive, and implementation version rather than rerunning 20 trials in every
selector process.

`ci`, `codex_app`, and Windows remain unsupported until they implement the same durable
handle, result, cancellation, and liveness contract. Production cutover remains
gated on vNext fact-store and inspect/recover integration; unsupported
environments return an actionable `inspect` result.
