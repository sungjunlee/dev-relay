# Relay Runtime Core Reset vNext

**Status:** implementation complete; migration withdrawn 2026-08-03; rollout evidence pending
**Date:** 2026-07-31
**Scope:** `relay-dispatch` runtime and the shared run contracts consumed by
`relay`, `relay-review`, `relay-merge`, `relay-fleet`, and `relay-config`

## Context

`skills/relay-dispatch/scripts` grew from 4 JavaScript files / 1,143 lines on
2026-04-01 to 75 files / 29,607 lines on 2026-07-31. Its dispatch test surface is
37,547 lines. The growth is mostly recent and incident-driven: every new
executor, routing feature, review assurance mode, crash recovery case, and
historical compatibility rule added another local mechanism.

The result is no longer a thin executor handoff. The package also acts as a
model router, policy engine, process supervisor, recovery matrix, analytics
engine, compatibility reader, app registrar, and shared manifest framework.
This increases change amplification and creates new failure modes in the
machinery intended to recover older ones.

This reset removes concepts before consolidating files. It does not achieve its
size target by reducing executor diversity.

## Goals

1. Reduce the installed `relay-dispatch/scripts` runtime from 75 JavaScript
   files to 14-18 files.
2. Reduce production runtime code from 29,607 lines to a 4,000-6,000 line
   budget. Delivered at 6,050 lines with no migration shims outstanding — 50
   lines over the band.
3. Replace eleven persisted workflow states with append-only durable facts and
   a derived current action.
4. Replace the recovery command family with one read-only `inspect` surface and
   one idempotent `recover` surface.
5. Preserve every currently supported executor and make future executor
   additions require only one small adapter.
6. Keep background work survival and duplicate-execution prevention while
   replacing the current PID/PGID/lease machinery with the smallest proven
   host contract.
7. Retain exact-SHA review, worktree isolation, auditable merge provenance, and
   explicit merge approval.

## Non-Goals

- Do not reduce the supported executor set to meet a file or line budget.
- Do not hard-code Codex or Claude as the only execution routes.
- Do not merge the existing files into fewer large files while retaining the
  same states, commands, flags, and recovery branches.
- Do not weaken worktree containment, path trust, review independence,
  exact-SHA freshness, or explicit merge approval.
- Do not rewrite terminal historical event journals.
- Do not preserve routing, assurance, or compatibility behavior solely because
  current tests and documentation reference it.
- Do not implement the reset as one clean-slate pull request.

## Verified Current State

Verified at commit `1731f8e` on 2026-07-31.

| Area | Current shape | Evidence |
| --- | ---: | --- |
| Dispatch runtime | 75 JS files / 29,607 LOC | `skills/relay-dispatch/scripts/` |
| Dispatch tests | 37,547 LOC | `tests/relay-dispatch/` |
| Primary entrypoint | 3,639 LOC | `skills/relay-dispatch/scripts/dispatch.js` |
| Persisted lifecycle | 11 states | `manifest/lifecycle.js` |
| Central CLI registry | 550 LOC | `cli-schema.js` |
| Routing engine | 1,417 LOC plus policy/config/model helpers | `relay-routing.js` and siblings |
| Reliability aggregation | 2,225 LOC plus calibration helpers | `reliability-report.js` |
| Recovery entrypoints | reconcile, recover-commit, recover-state, rebrand, close, wait | dispatch scripts |
| Executor support | codex, claude, cursor, opencode, pi, antigravity, cline | `executors/` |
| Adapter registry | 1,257 LOC descriptor table | `agent-adapters/index.js` |

Recent live incidents prove that background survival and recovery are not
theoretical. Detached execution recovered killed-but-complete work, Cursor
served as a quota fallback, and stale evidence / recovered SHA errors occurred
in real runs. Those contracts must be replaced before their current
implementations are removed.

## Implementation Snapshot (2026-08-02)

- Installed dispatch runtime: 16 JavaScript files / 6,050 LOC (measured into
  `tests/ledger/vnext-baseline.generated.json`).
- All seven native executors remain registered; the unused generic argv-template
  framework was removed so native descriptors are the only extension path.
- The serialized repository gate on Node v22.22.3 reported 707 tests, 705 passed,
  0 failed, 2 skipped **on 2026-08-02, before the overlay deletion**. Both skips
  were then-approved opt-in provider canaries (`opencode-live`, `pi-live`). The
  two deleted suites took 64 test declarations with them, so the current count
  is lower; re-measure rather than quoting this line.
- Independent lifecycle re-review is LGTM after PID-reuse, zombie, quarantine,
  signed-close, and reviewer-cleanup regressions were closed.
- The historical provider release matrix was incomplete at 2/13. It was
  retired by #1234 because operator credentials and installed CLIs are not a
  repository release condition.
- The migration overlay was deleted on 2026-08-03 rather than exercised. There
  are no shims, no writer generation, and no retirement gate; vNext admits
  itself and claims a run directory with a non-recursive `mkdir`.

## Durable Invariants

The vNext implementation must make these executable contracts:

1. **Worktree containment:** executor writes never target the user's active
   checkout or an untrusted path outside the retained relay worktree.
2. **Frozen outcome contract:** Done Criteria are content-addressed at run
   creation and no later path mutates the frozen bytes.
3. **Immutable identity:** run id, repository identity, branch/base, worktree,
   role bindings, and optional fleet parent/ownership digest do not change.
4. **Single actor:** at most one dispatch/recovery actor may mutate a run
   worktree at a time.
5. **Append-only attempts:** attempt start, completion, interruption, and
   recovery outcomes are appended atomically and never rewritten.
6. **Exact review binding:** a review verdict is valid only for the exact
   `(commit SHA, Done Criteria hash)` pair it reviewed.
7. **Independent review:** executor session state cannot influence the
   independent reviewer verdict.
8. **Explicit merge:** merge begins only from an operator action and requires a
   passing verdict for the current PR head unless an audited override is used.
9. **Merge provenance:** relay records PR identity, reviewed source SHA,
   resulting target SHA, merge method, timestamp, operator, and override reason.
10. **Crash-safe idempotency:** applying `recover` twice has the same durable
    result as applying it once and never creates duplicate executor
    invocations, commits, PRs, or merges.
11. **Terminal irreversibility:** merged and explicitly closed runs cannot
    re-enter an active attempt.
12. **External revalidation:** mutable GitHub facts are re-read before actions;
    cached liveness fields never authorize merge or recovery.

## vNext Durable Data Model

### `run.json`

Written atomically at run creation. Fields are immutable after creation.

```json
{
  "version": 3,
  "run_id": "issue-42-...",
  "repo": {
    "root": "/canonical/repo",
    "remote": "owner/name"
  },
  "git": {
    "branch": "issue-42",
    "base_branch": "main",
    "worktree": "/retained/worktree",
    "start_sha": "..."
  },
  "contract": {
    "done_criteria_path": ".../done-criteria.md",
    "done_criteria_sha256": "..."
  },
  "roles": {
    "orchestrator": "codex",
    "executor": "cursor",
    "reviewer": "claude"
  },
  "parent": {
    "kind": "fleet",
    "id": "optional"
  },
  "ownership_digest": "optional",
  "created_at": "ISO-8601"
}
```

`parent` and `ownership_digest` are nullable but immutable. They preserve fleet
orphan recovery without making the dispatch core understand fleet state.

### `events.jsonl`

Each line is one atomic fact:

```json
{
  "event_id": "uuid",
  "run_id": "...",
  "attempt_id": "...",
  "type": "attempt_started",
  "at": "ISO-8601",
  "actor": "codex",
  "payload": {}
}
```

Required vNext event types:

- `attempt_started`
- `attempt_finished`
- `attempt_interrupted`
- `verification_recorded`
- `lock_acquired`
- `lock_released`
- `pull_request_recorded`
- `review_recorded`
- `recovery_applied`
- `merge_recorded`
- `run_closed`

Writers validate the event envelope and the type-specific payload. Readers must
preserve unknown historical events and reject unknown future run versions.

### Event payload contracts

Every event has `event_id`, `run_id`, `type`, `at`, `actor`, and `payload`.
Attempt-scoped events additionally require `attempt_id`. Payloads are closed
schemas: unknown fields fail writes and are preserved by historical reads.

| Type | Required payload |
| --- | --- |
| `attempt_started` | `executor`, nullable `model`, `start_sha`, `host_kind`, `host_handle`, `stdout_path`, `stderr_path`, `result_path`, `timeout_ms` |
| `attempt_finished` | `status`, `start_sha`, `final_sha`, `tree_sha`, `result_path`, `exit_code`, `verification_status` |
| `attempt_interrupted` | `last_known_sha`, `reason`, `host_liveness`, `reviewable_work` |
| `verification_recorded` | `head_sha`, `tree_sha`, `done_criteria_sha256`, `command`, `verification_request_sha256`, `declared_command_count`, `completed_command_count`, `result_path`, `result_sha256`, `exit_code`, `status`, `operator` |
| `lock_acquired` | `lock_id`, `operation`, `host`, nullable `pid`, nullable `process_started_at` |
| `lock_released` | `lock_id`, `operation`, `outcome` |
| `pull_request_recorded` | `pr_number`, `repo`, `head_ref`, `base_ref`, `head_sha`, `created_by_relay` |
| `review_recorded` | `round`, `verdict`, `reviewed_sha`, `done_criteria_sha256`, `reviewer`, `review_artifact`, nullable `override` |
| `recovery_applied` | `rule`, `observed_event_id`, `before_sha`, `after_sha`, `side_effects`, `reason`, `operator` |
| `merge_recorded` | `pr_number`, `reviewed_source_sha`, `pr_head_sha`, `result_target_sha`, `method`, `operator`, nullable `override_reason` |
| `run_closed` | `reason`, `operator`, `last_sha`, nullable `pr_number` |

`verification_status` is `passed | failed | incomplete | not_declared`. An
executor process exit code never implies that a declared verification command
passed.

`verification_recorded` is the independently auditable proof used by the
review/merge gate. Its envelope `at` is the recording time and its actor must
equal `payload.operator`; `passed` requires `exit_code: 0` and completion of
every declared command, while incomplete verification records `exit_code: null`
and fewer completed than declared commands. A proof for another commit, Git
tree, or frozen Done Criteria is stale and cannot authorize review completion
or merge. vNext runs fail closed when a declared verification has no proof;
the legacy shadow reader is the only explicit compatibility projection allowed
to model pre-proof historical rows.

### Atomic append

All event writes occur while holding the per-run exclusive lock. The writer:

1. serializes a canonical single-line JSON record no larger than 64 KiB;
2. opens `events.jsonl` with `O_APPEND | O_CREAT | O_WRONLY`;
3. issues exactly one `writeSync` call for the complete line plus newline;
4. calls `fsyncSync` before releasing the lock.

Readers accept only newline-terminated records. An incomplete trailing record
is reported as `event_tail_incomplete` and ignored for folding; only `recover`
may truncate that tail while holding the lock, after preserving it as
`events.corrupt-tail.<timestamp>`. Interior malformed records fail closed.

### Derived lifecycle

No mutable `state` or `next_action` field is written by vNext.

`foldRunFacts(run, events, gitFacts, githubFacts)` returns:

```json
{
  "phase": "running | reviewable | terminal",
  "action": "wait | recover | review | redispatch | merge | none",
  "reason": "stable_machine_code",
  "head_sha": "...",
  "reviewed_sha": "...",
  "pr_number": 123,
  "terminal_kind": "merged | closed | null"
}
```

### Fold precedence and action table

Facts are ordered by their append position. Duplicate `event_id` or conflicting
terminal events fail closed. Durable terminal facts outrank all active facts.
Live Git/GitHub observations may invalidate an action but may never erase a
durable event.

| Durable/live facts | Phase | Action | Reason |
| --- | --- | --- | --- |
| `run_closed` tail fact | `terminal` | `none` | `closed` |
| `merge_recorded` tail fact | `terminal` | `none` | `merged` |
| GitHub confirms recorded PR is merged but no merge event exists | `reviewable` | `recover` | `merged_pr_unrecorded` |
| latest attempt has no terminal attempt event and host is live | `running` | `wait` | `attempt_live` |
| latest attempt has no terminal attempt event and host is not provably live | `running` | `recover` | `attempt_liveness_unknown` |
| latest attempt interrupted and no reviewable work exists | `reviewable` | `redispatch` | `interrupted_no_work` |
| final worktree SHA exists but no PR is recorded | `reviewable` | `recover` | `publication_incomplete` |
| recorded PR head differs from latest passing reviewed SHA | `reviewable` | `review` | `review_stale` |
| latest review verdict is `changes_requested` for current SHA | `reviewable` | `redispatch` | `changes_requested` |
| passing review matches current PR head and Done Criteria hash | `reviewable` | `merge` | `ready_to_merge` |
| GitHub is unavailable and the requested action needs live GitHub facts | unchanged | `none` | `github_unavailable` |
| durable and live facts contradict identity, repo, branch, or terminal history | unchanged | `none` | `fact_conflict` |

`reviewable work` means either the worktree tree differs from `start_sha`, the
branch has a commit not reachable from the base, or a regular result artifact
exists. Runtime-only metadata paths are excluded by the same allowlist used for
staging. `operator verification` means a regular file plus an explicit command,
exit code, timestamp, operator, and verified tree SHA. `available CLI` means
`probe()` returns a parsed version and the adapter conformance check for that
version is not quarantined.

PR open/closed state, current PR head, checks, and merge liveness are fetched
from GitHub. PR identity and relay-performed merge provenance remain durable
events because squash/rebase, force-push, branch deletion, repository rename,
or API unavailability can make historical derivation impossible.

## Universal Executor Adapter Contract

All current executors remain supported:

- Codex
- Claude
- Cursor
- OpenCode
- Pi
- Antigravity
- Cline

Future executors are first-class additions, not exceptional branches.

Each adapter exports exactly four functions plus static metadata:

```js
module.exports = {
  name: "cursor",
  defaults: { timeoutMs: 1800000 },

  probe({ env, timeoutMs }) {},

  capabilities({ phase }) {
    return {
      write: true,
      readOnly: false,
      networkControl: "native | informational | unsupported",
      cancellation: "process | native | unsupported",
      structuredOutput: "json | jsonl | text"
    };
  },

  buildInvocation({
    phase,
    cwd,
    promptPath,
    resultPath,
    model,
    timeoutMs,
    sandbox,
    networkAccess
  }) {
    return { command: "agent", args: [], cwd };
  },

  parseOutcome({
    exitCode,
    stdoutPath,
    stderrPath,
    resultPath
  }) {
    return {
      status: "succeeded | failed | cancelled | timed_out | empty",
      summary: "",
      resultPath: null
    };
  }
};
```

Rules:

- `command` and every `args` item are separate argv values.
- Adapters never return shell command strings.
- Adapters do not own manifest transitions, recovery, routing precedence,
  publication, app registration, or review budgets.
- `model` is an opaque caller-selected value recorded in the attempt event.
- Dispatch and review consume the same descriptor and phase capabilities.
- App/session registration is an optional host integration, not an adapter
  lifecycle side effect.
- Adding a new adapter requires one file and conformance fixtures; it does not
  change dispatch, review, recovery, routing, or manifest code.

The registry intentionally contains only native descriptors for supported
executors. Adding a future executor means adding one reviewed four-method
descriptor and its conformance fixtures; it does not admit operator-provided
argv templates, executable paths, or dynamically configured code.

## Host, Exclusion, and Survival Contract

The current detach implementation remains until its replacement passes the
survival gate.

The replacement host contract records:

```json
{
  "attempt_id": "...",
  "host_kind": "codex_app | ci | local_supervisor",
  "host_handle": "...",
  "started_at": "...",
  "timeout_ms": 1800000,
  "stdout_path": "...",
  "stderr_path": "...",
  "result_path": "..."
}
```

Before any executor or recovery mutation, relay acquires a per-run exclusive
lock using an atomic create (`O_CREAT | O_EXCL`). The lock contains
`attempt_id`, host identity, process identity where applicable, and acquisition
time. A stale lock is never stolen from process existence alone: `inspect`
must combine host liveness, attempt facts, worktree facts, and a bounded stale
policy. Lock acquisition and release are audit events.

The chosen host implementation must preserve:

- caller shell exit survival;
- durable stdout/stderr/result locations;
- bounded cancellation;
- no concurrent executor/recovery mutation;
- recovery after supervisor death or machine restart.

### Host selection and stale-lock recovery

The first host workstream runs the same 20 caller-exit / terminal-close /
sleep-wake trials against host-owned execution and the current local
supervisor. Host-owned execution replaces the supervisor only when it supplies
a durable handle, durable logs, bounded cancellation, and zero lost outcomes in
all 20 trials. Otherwise vNext keeps one thin local supervisor.

A lock is live only when all available identity fields agree: host kind, host
handle, hostname, process id where applicable, and process start time. After a
restart or when the host API is unavailable, the lock is `unknown`, not stale.
`recover --break-lock --reason <text>` is the only stale-lock override. It
requires either a host API terminal result or two liveness probes ten seconds
apart with no matching process start identity. Breaking a lock appends
`lock_released(outcome=broken)` before a new lock is acquired. Automatic lock
stealing is forbidden.

## `inspect` and `recover`

### `inspect`

Read-only. It resolves the run, validates trusted paths, folds durable events,
reads Git/worktree facts, optionally reads GitHub facts, and returns one typed
action with its proof requirements.

### `recover`

Mutating and idempotent. Its fixed order is:

```text
observe
→ choose one typed recovery rule
→ verify rule-specific proof
→ prevalidate terminal/exclusion constraints
→ acquire lock
→ perform side effects
→ append recovery/result events
→ release lock
```

The initial recovery rules are intentionally limited:

1. live attempt → report `running`, no mutation;
2. dead attempt + no reviewable work → append `attempt_interrupted`, recommend
   redispatch;
3. dead attempt + reviewable work/result → commit if needed, publish if policy
   permits, bind the final SHA, append `attempt_finished`;
4. existing PR + operator verification at the same SHA → append audited review
   evidence without requiring a new commit;
5. externally merged PR → append `merge_recorded` only after GitHub confirms
   `MERGED`, preserving any audited override.

Anything else returns `needs_operator` with a stable reason and required proof.

After selecting a candidate rule, `recover` acquires the lock and repeats every
Git, worktree, event-tail, and GitHub observation used by that rule. If any
value changed, it releases the lock without side effects and returns
`observation_changed`; it never continues from the pre-lock observation.

Publication rules are exact:

- one open PR whose head repository/ref match the immutable run branch is reused;
- more than one matching open PR returns `ambiguous_pr`;
- a recorded PR whose live head ref or repository differs returns
  `recorded_pr_identity_mismatch`;
- a force-pushed PR whose current head differs from the worktree HEAD returns
  `remote_head_diverged`;
- a clean worktree with an unpushed commit pushes that commit;
- a dirty worktree stages only reviewable paths, commits once with the run id,
  then records the final tree and commit SHA;
- a clean worktree with an existing PR may record same-SHA operator
  verification without inventing a commit;
- publication is permitted only for `publish_policy=immediate`; delayed
  publication is removed by the product-surface workstream;
- every PR create passes explicit base and head refs;
- create failure is followed by one exact-head lookup to converge on a PR
  created concurrently.

Independent review is enforced by a new process invocation that receives only
the immutable run record, frozen Done Criteria, PR/diff facts, and reviewer
prompt. It does not receive the dispatch prompt, executor transcript, executor
session id, or mutable executor process state. Reviewer adapters are invoked in
read-only mode when native support exists; otherwise a clean detached review
worktree and pre/post status equality check are mandatory.

## Product Surface Subtraction

Delete from the installed runtime:

- tag-based routing;
- route presets;
- model catalog fallback;
- global/project/run route precedence;
- advisory review lanes and assurance profiles;
- runtime reliability aggregation and calibration;
- central cross-command CLI schema;
- duplicated recovery entrypoints;
- mutable PR liveness cache fields;
- completed-run compatibility execution paths.

Keep:

- raw structured event emission;
- explicit `--executor` and optional opaque `--model`;
- all current executor adapters;
- exact-SHA independent review;
- fleet parent/ownership back-pointers;
- explicit merge and merge provenance.

Moving a mechanism to another bundled skill does not count as subtraction.
Bundle-wide production LOC and imports are measured.

## Target Runtime Shape

```text
skills/relay-dispatch/scripts/
  dispatch.js
  inspect.js
  recover.js
  run-store.js
  facts.js
  host.js
  adapter-contract.js
  adapters/
    index.js
    codex.js
    claude.js
    cursor.js
    opencode.js
    pi.js
    antigravity.js
    cline.js
```

The exact file count may vary within 14-18. The concept budget is binding:

- no persisted mutable state/next-action pair;
- one immutable run record;
- one append-only event stream;
- one `inspect` and one `recover` mutation surface;
- one adapter protocol;
- four adapter methods;
- zero executor-name branches in dispatch/review/recovery;
- zero shell-string adapter invocations.

## Test Strategy

Before replacing implementation, extract black-box contracts from existing
incident tests.

| Contract group | Required coverage |
| --- | --- |
| Containment | active checkout unchanged; traversal, symlink, FIFO, and untrusted run path rejected |
| Atomicity | kill before/after each append; previous facts remain readable |
| Exclusion | active executor plus concurrent recover never duplicates work |
| Identity | reviewed SHA = recorded SHA = published PR head |
| Review | any new commit invalidates the previous verdict |
| Publication | duplicate recover creates no duplicate commit or PR |
| Merge | explicit merge only; source/result SHA event recorded |
| Selection | unknown or ambiguous run selector fails closed |
| ~~Migration~~ | ~~old read → vNext copy-on-write is idempotent~~ — withdrawn 2026-08-03; there is no migration and no legacy reader |
| Adapter | success, failure, timeout, cancellation, empty output, malformed structured output, missing binary |

Classify each existing test:

- `retain-contract`
- `migrate-contract`
- `delete-with-capability`
- `historical-reader-only`

Delete exact error text, exhaustive old-state matrices, and helper-level tests
when the associated implementation is removed. Retain the smallest
anti-regression case that fails if the invariant is removed.

## Migration — withdrawn 2026-08-03

This section planned a drain-and-cutover / dual-read migration, an explicit
legacy-to-vNext record mapping, and a `runtime-generation` marker switched
atomically between `legacy` and `vnext`. **None of it shipped, and the code
that implemented part of it has been deleted.** Read it as design history only.

There is no migration. The legacy manifest reader went with the runtime reset
in #1140, so no installed script can read a pre-vNext run: a repository holding
pre-vNext state does not migrate, it starts its next run as a vNext run. Nothing
admits a writer, records a generation, or translates retired argv.

The overlay was measured before it was removed. Every path to a dispatchable
vNext marker required an external Ed25519 attestation whose file and every
parent directory up to `/` had to be owned by a different UID and non-writable
by the operator — satisfiable on a single-operator machine only by becoming root
and signing to yourself. See
[docs/decisions/2026-08-03-migration-overlay-disposition.md](../../decisions/2026-08-03-migration-overlay-disposition.md).


## Delivery Plan

```text
Foundation contracts and inventory
        |
        +--> vNext fact model + shadow fold
        |          |
        |          +--> inspect/recover convergence
        |
        +--> host survival + exclusion replacement
        |
        +--> universal adapter protocol + all executor migrations
        |
        +--> product-surface subtraction
                       |
                       v
               old runtime deletion
```

The dispatch entrypoint is rewritten only after the fact model, host contract,
adapter contract, and removal list are proven. Refactoring the existing
3,639-line file into helpers before subtraction is explicitly forbidden.

## Rollout Gates

1. **Contract gate:** every durable invariant has a failing-then-passing
   black-box test.
2. **Shadow gate:** 30 normal runs produce zero old/new action mismatches, zero
   stale-SHA approvals, and zero terminal reopenings.
3. **Crash gate:** at least 10 forced interruptions across spawn, dirty tree,
   commit-before-push, and push-before-PR points lose no reviewable work.
4. **Exclusion gate:** 50 concurrent supervisor/recover trials create zero
   duplicate executor invocations, commits, PRs, or merges.
5. **Adapter gate:** every current executor passes the shared transcript suite;
   live canaries prove at least success/failure/timeout for each available CLI,
   with zero failures classified as success.
6. **Fleet gate:** five two-leaf fleets preserve parent back-pointers, recover
   orphaned children, and never double-dispatch.
7. **Migration gate:** withdrawn with the migration itself. Non-terminal legacy
   runs neither migrate nor close; they are unreadable and stay that way.
8. **Canary gate:** no wrong merge, lost work, criteria drift, duplicate
   invocation, or wrong-SHA review across 30 vNext runs and at least 14 calendar
   days.
9. **Subtraction gate:** final runtime is 14-18 files and 4,000-6,000 production
   LOC, with the current executor set still supported. Delivered at 16 files /
   6,050 LOC — inside the file target, above the LOC band because production CLI
   isolation (#1141) added credential staging, the signed two-phase cleanup
   lifecycle, and runtime-identity binding.

## Rollback

- Each workstream landed independently behind a shadow reader until its gate
  passed. That scaffolding is gone with the old runtime path.
- No rollback rewrites terminal event history.
- Any wrong merge, duplicate invocation, lost work, or stale-SHA acceptance
  immediately stops the rollout and restores the last proven path.
- There is no cutover rollback, because there was no cutover: vNext is the only
  writer and the prior entrypoints and reader are deleted, not shadowed.

## Implementation Issues

| Order | Issue | Workstream | Depends on |
| --- | --- | --- | --- |
| 1 | [#1130](https://github.com/sungjunlee/dev-relay/issues/1130) | Executable invariants, runtime inventory, test deletion ledger | — |
| 2a | [#1131](https://github.com/sungjunlee/dev-relay/issues/1131) | Durable host/exclusion contract and crash drills | #1130 |
| 2b | [#1132](https://github.com/sungjunlee/dev-relay/issues/1132) | Immutable fact store and shadow lifecycle fold | #1130 |
| 2c | [#1133](https://github.com/sungjunlee/dev-relay/issues/1133) | Universal executor adapter and migration of every current executor | #1130 |
| 2d | [#1134](https://github.com/sungjunlee/dev-relay/issues/1134) | Runtime policy/assurance/analytics/CLI subtraction | #1130 |
| 3 | [#1135](https://github.com/sungjunlee/dev-relay/issues/1135) | Read-only `inspect` and idempotent `recover` | #1131, #1132 |
| 4 | [#1136](https://github.com/sungjunlee/dev-relay/issues/1136) | Dispatch rewrite and legacy runtime deletion | #1131–#1135 |

Umbrella: [#1129](https://github.com/sungjunlee/dev-relay/issues/1129).

## Existing Issue Disposition

The implementation epic must explicitly link and either absorb, supersede, or
retain these open issues:

- `#755` state-machine re-review path: replaced by derived action from exact
  reviewed SHA and live PR head.
- `#1110` runtime-dirt simplification: absorb its staging simplification into
  the new worktree fact collector.
- `#1113`, `#1114`, `#1118`, `#1123`: absorb as exact-SHA evidence and
  idempotent recovery contract cases.
- `#1115`: absorb as external merged-PR reconciliation plus merge provenance.
- `#1117`: removed with review-budget / reviewer-swap state machinery.
- `#838`: keep separate unless review interruption is included in the selected
  host contract.
- `#726`: session/transcript pointers remain optional host facts, not core run
  state.
- `#783` and `#868`: superseded if routing configuration is removed from the
  product; otherwise explicitly narrowed to adapter registration only.

## Definition of Done

1. All rollout gates pass.
2. Every current executor remains selectable and passes the shared adapter
   contract.
3. No dispatch/review/recovery code branches on a concrete executor name.
4. The old eleven-state writer and recovery entrypoints are removed.
5. The current routing/advisory/analytics runtime surfaces are removed rather
   than moved within the bundle.
6. ~~Active legacy runs are drained or migrated without losing audit history.~~
   Withdrawn 2026-08-03 with the migration. Legacy runs are neither drained nor
   migrated: the legacy manifest reader is deleted, so they are unreadable and
   their audit history is untouched because nothing reads or writes it.
7. The full bundle test suite passes with the new black-box contract suite.
8. Documentation describes one run fact model, one adapter protocol, and one
   recovery flow.
9. Final measured runtime is 14-18 JavaScript files and 4,000-6,000 production
   lines, excluding tests and terminal historical fixtures. **NOT MET at 16
   files / 6,050 lines:** the file target is met, the LOC band is exceeded by
   50 lines. The overrun is production CLI isolation (#1141), not migration
   scaffolding, so no remaining deletion closes it. This item stays unsatisfied
   until either the runtime drops below 6,000 or the band is explicitly raised.

The subtraction measurement includes every shipped JavaScript file imported or
executed by `relay-dispatch`, including shared bundle modules, generated runtime
code, compatibility shims, and adapter files. It excludes tests, fixtures,
Markdown, archived one-off analysis tools outside installed skills, and
terminal user data. The 4,000-6,000 line gate is live now that no shims remain,
and the measured runtime misses it by 50 lines; see Definition of Done item 9.
