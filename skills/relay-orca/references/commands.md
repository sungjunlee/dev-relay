# relay-orca commands

## `plan` — read-only wave-plan compiler

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/plan.js" \
  --program-file <accepted-program.json> [--json] [--concurrency N]
```

| Flag | Meaning |
| --- | --- |
| `--program-file`, `-f` | Path to the accepted-program JSON contract (required). May also be passed positionally. |
| `--json` | Emit the compiled plan (or the rejection object) as JSON on stdout. |
| `--concurrency N` | Override the program's concurrency ceiling. Default 2, hard maximum 4. |
| `--help`, `-h` | Print usage. |

`plan` is **READ-ONLY** (D6): it reads only the program file and writes only to
stdout/stderr. It creates no Orca task or terminal, no relay request/run/worktree, no pull
request, and no tracker issue. It spawns no subprocess and imports no cross-skill module.

### Plan output

On success `plan` prints a stable, deterministic object:

- `program_id`, `source`, `repo`, `tracker`, `concurrency`
- `exit_gates`, `decision_gates` (echoed)
- `invariants` — the ownership invariants (see [task-kinds.md](task-kinds.md))
- `waves[]` — ordered, immutable waves `{ wave, task_ids }`; same-wave tasks are always
  mutually independent
- `tasks[]` — one per outcome: `task_id`, `outcome_id`, `kind`, `wave`, `depends_on`
  (task ids), `recommended_route` (operator surface only), `decision_gate`,
  `expected_evidence`

The same input always yields byte-identical output (no timestamps, no randomness).

## Rejection matrix

Each rejection exits with a **distinct non-zero code** and, under `--json`, prints
`{ "ok": false, "reason_code": "...", "message": "..." }`.

| Done Criteria | reason_code | exit | Trigger |
| --- | --- | --- | --- |
| D7(a) | `VAGUE_INTENT` | 10 | An outcome lacks accepted outcomes (raw/vague intent). |
| D7(b) | `MISSING_EXIT_GATES` | 11 | The program has no non-empty exit gate. |
| D7(c) | `UNPREPARED_FLEET_LEAF` | 12 | A `relay_fleet` outcome has no prepared prompt/rubric/Done-Criteria leaf. |
| D7(d) | `DEPENDENCY_CYCLE` | 13 | The dependency graph contains a cycle. |
| D7(e) | `SAME_WAVE_DEPENDENCY` | 14 | A dependency does not resolve to a strictly earlier declared wave. |
| D7(f) | `UNSUPPORTED_TASK_KIND` | 15 | A `task_kind` is outside the five supported kinds. |
| D7(g) | `CONCURRENCY_EXCEEDED` | 16 | Concurrency exceeds the hard maximum of 4. |
| D9 | `NESTED_RELAY_ORCA` | 20 | An outcome/program nests relay-orca. |
| D9 | `EXCESSIVE_DEPTH` | 21 | An outcome declares sub-orchestration beyond one operator layer. |

Structural guards use their own codes: `INVALID_INPUT` (2), `DUPLICATE_OUTCOME_ID` (3),
`UNKNOWN_DEPENDENCY` (4), `INVALID_WAVE_DECLARATION` (5). Missing/unreadable program files or
unknown flags exit `64` (usage).

## `probe` — fail-closed Orca capability admission

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" \
  [--json] [--smoke] [--orca-bin <path>]
```

| Flag | Meaning |
| --- | --- |
| `--json` | Emit the D8 admission envelope as JSON on stdout. |
| `--smoke` | After default checks pass, run a self-cleaning synthetic injection smoke. |
| `--orca-bin <path>` | Explicit Orca CLI override (wins over PATH and the macOS bundle fallback). |
| `--help`, `-h` | Print usage. |

Default mode is **READ-ONLY**: it spawns only `orca status --json`,
`orca orchestration task-list --json`, and `orca orchestration gate-list --json`. It never
invokes `orca orchestration reset`. Full rationale, check order, smoke semantics, and the
reason-code table: [capability-probe.md](capability-probe.md).

### Probe rejection matrix

| reason_code | exit | Trigger |
| --- | --- | --- |
| `BINARY_NOT_FOUND` | 30 | `--orca-bin`, PATH, and macOS bundle fallback all miss |
| `RUNTIME_NOT_READY` | 31 | Well-formed `status` fails a readiness conjunct |
| `ORCHESTRATION_UNAVAILABLE` | 32 | Orchestration absent, disabled, or `ok:false` |
| `MALFORMED_OUTPUT` | 33 | Unparseable or shape-invalid JSON |
| `EXISTING_ORCHESTRATION_STATE` | 34 | Task or gate count `> 0` (never adopted) |
| `AMBIGUOUS_GLOBAL_STATE` | 35 | Non-integer count, a count that disagrees with its own array length, or `_meta.runtimeId` mismatch |
| `SMOKE_FAILED` | 36 | Smoke provenance (task/dispatch/assignee) failed |
| `SMOKE_CLEANUP_FAILED` | 37 | Smoke cleanup of self-created state failed |

Usage errors exit `64`.

Every Orca invocation carries a finite timeout (default 10000 ms), so a hung CLI
still classifies through the matrix above and emits the JSON envelope instead of
hanging. `RELAY_ORCA_PROBE_TIMEOUT_MS` (positive integer; invalid values ignored)
shortens the budget for tests.

## `run` — admission-gated provenance-injected operator dispatch

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/run.js" \
  --program-file <accepted-program.json> [--json] [--concurrency N] \
  [--operator-handle <handle> ...] [--orca-bin <path>]
```

| Flag | Meaning |
| --- | --- |
| `--program-file`, `-f` | Accepted-program JSON contract (required) — the SAME input as `plan`. A precompiled plan JSON is NOT accepted (prevents tampered-plan injection). May be passed positionally. |
| `--json` | Emit the machine-readable run report as JSON on stdout. |
| `--concurrency N` | Override the concurrency ceiling. Default 2, hard maximum 4 (rejected via the plan library). |
| `--operator-handle <handle>` | Repeatable. An explicit operator terminal handle to dispatch to — REQUIRED. `run` dispatches ONLY to handles provided here and never creates its own terminal (a self-created terminal has no recognized agent and cannot accept `--inject`). With zero handles, `run` fails closed with `OPERATOR_DISPATCH_FAILED` (44) before any mutation. Each handle must be a terminal already running an agent CLI (`orca terminal create --command "<agent-cli>" --json`). |
| `--orca-bin <path>` | Explicit Orca CLI override — passed to the capability probe and used for all orchestration calls. |
| `--resolve-decision <id>` | (#947) Write a resolved `decision:` record for `<id>` into the receipt's `decisions[]`. Requires `--resolution` and `--resolver`; provenance (question/options/downstream_wave) is sourced from the program's declared `decision_gates[<id>]`. Never automatic. |
| `--resolution <text>` | The decision resolution (with `--resolve-decision`). |
| `--resolver <handle>` | Who resolved the decision (with `--resolve-decision`). |
| `--record-authorization <id>` | (#947) Write an `authorization:` record for `<id>` into the receipt's `authorizations[]`. Requires `--authorizer`. Never automatic. |
| `--authorizer <handle>` | Who authorized (with `--record-authorization`). |
| `--help`, `-h` | Print usage. |

The #947 record flags are additive: without them the receipt is byte-identical to a
pre-#947 run. See [gates-and-completion.md](gates-and-completion.md).

`run` compiles the program through the FROZEN plan library, then requires capability
admission from the FROZEN #942 probe **before any mutation**. Only after admission does it
materialize the wave plan as `orca orchestration task-create` tasks (dependency order, deps
carried as real Orca task ids), dispatch provenance-injected operators, verify each dispatch
via `orca orchestration dispatch-show`, and deliver the operator prompt. It **never** invokes
`orca orchestration reset` (D2) or any `orca worktree` subcommand (D5) — relay owns every
implementation worktree. Plan-library rejections (`VAGUE_INTENT` … `EXCESSIVE_DEPTH`,
`UNPREPARED_FLEET_LEAF`, `CONCURRENCY_EXCEEDED`, `NESTED_RELAY_ORCA`, structural guards)
re-raise verbatim with their existing reason codes and exit codes.

### Run report (`--json`)

Exactly these top-level keys: `ok`, `program_id`, `admission`, `concurrency`, `tasks`,
`terminals_created`, `blocking_reasons`, `reconciliation_required`, `receipt_path`. Each
`tasks[]` entry is `{ task_id, outcome_id, kind, wave, orca_task_id, dispatch_id, assignee,
status }` where `status` is `dispatched | pending | escalated`; a `dispatched` entry always
carries the full non-null provenance trio. `reconciliation_required` is literally `true` in
every report — run NEVER claims completion. `receipt_path` (#945) is the path of the
atomically-written reconstructible receipt (or `null` on paths that never materialize tasks);
see [receipt-and-status.md](receipt-and-status.md).

### Partial-wave semantics

Only wave-1 tasks (all dependency-satisfied) are dispatch-eligible in v0; later waves are
materialized but reported `pending`. At most `concurrency` tasks are dispatched at once — excess
eligible tasks stay `pending` with **no error** (exit 0). A handle carries at most one active
task; an explicit-handle shortfall also leaves the remaining eligible tasks `pending`.
Completion-driven wave advancement is #945/#947 scope.

### Run rejection matrix

| reason_code | exit | Trigger |
| --- | --- | --- |
| `ADMISSION_REJECTED` | 40 | The capability probe rejected or reported `admitted:false` (no mutation ran). |
| `TASK_MATERIALIZE_FAILED` | 41 | An `orca orchestration task-create` failed; earlier tasks are left in place and listed. |
| `INJECTION_UNDELIVERED` | 42 | An `orca orchestration dispatch --inject` failed (or the post-verification prompt hand-off failed). |
| `PROVENANCE_MISMATCH` | 43 | `dispatch-show` returned a null/empty/mismatched task id, dispatch id, or assignee. |
| `OPERATOR_DISPATCH_FAILED` | 44 | No operator terminal was provided: `run` was invoked with zero `--operator-handle` (it never self-creates a terminal). Rejected upfront, before any mutation. |

A `42`/`43` failure records the failing task `escalated`, dispatches no further pending task,
and does not touch already-verified running operators (stop semantics are #946). Plan-library
rejections re-raise codes `2`–`21`; usage errors exit `64`. A repo root that cannot be
git-canonicalized fails closed with `RECEIPT_REPO_MISMATCH` (exit `52`) — there is **no**
realpath fallback (A24). Full operator prompt contract and provenance rules:
[operator-dispatch.md](operator-dispatch.md).

## `status` — read-only live reconciler

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/status.js" \
  --program-id <program-id> [--json] [--orca-bin <path>] [--gh-bin <path>] [--repo-root <path>]
```

| Flag | Meaning |
| --- | --- |
| `--program-id`, `-p` | The accepted program's stable id (required). Resolves the receipt under the programs root. |
| `--json` | Emit the machine-readable status report as JSON on stdout. |
| `--orca-bin <path>` | Explicit Orca CLI override for the read-only runtime queries. |
| `--gh-bin <path>` | Explicit `gh` CLI override (or env `RELAY_ORCA_GH_BIN`). |
| `--repo-root <path>` | Explicit repo root for slug derivation (defaults to the git repo of the cwd). |
| `--help`, `-h` | Print usage. |

`status` loads the reconstructible receipt, then queries relay manifests, GitHub, and Orca
**live** to derive a normalized program view. It is strictly **READ-ONLY**: no GitHub write,
no relay manifest write, no Orca mutating subcommand or `reset`/`worktree`, and no receipt
write. Durable truth outranks runtime signals and `worker_done` is never completion evidence.

### Status report (`--json`)

Exactly these top-level keys: `ok`, `program_id`, `receipt_path`, `runtime`, `program_state`,
`outcomes`, `diagnostics`, `repair_candidates`, `evidence_checked`. `runtime` is
`ok | mismatch | foreign_state | unreachable`; `evidence_checked` is literally `true`. Each
`outcomes[]` entry is `{ outcome_id, kind, wave, state, orca_task_id, dispatch_id, relay_ids,
issue_url, pr_url, evidence }`. State taxonomy, the nine detector codes, the authority order,
and the read-only guarantee: [receipt-and-status.md](receipt-and-status.md).

### Status rejection matrix

| reason_code | exit | Trigger |
| --- | --- | --- |
| `RECEIPT_NOT_FOUND` | 50 | No receipt for `--program-id` under the programs root. |
| `RECEIPT_CORRUPT` | 51 | Unparseable JSON, wrong `schema`, or missing required keys. |
| `RECEIPT_REPO_MISMATCH` | 52 | The receipt `repo.slug` does not match the current repo, **or** the repo root could not be git-canonicalized (fail-closed, no realpath fallback — A24). |

Usage errors exit `64`. A successfully derived view exits `0` even when it is full of
`inconsistent`/`stale_missing` outcomes; runtime mismatch and unreachable Orca/GitHub degrade
to diagnostics rather than failing.

### Gate + completion modes (`--gates` / `--final-summary`, #947)

Two additional READ-ONLY `status` modes (no new intent) evaluate the program's exit gates
and declare evidence-backed completion:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/status.js" \
  --program-id <program-id> --gates --program-file <accepted-program.json> \
  [--gate-evidence-dir <dir>] [--record-proposals] [--strict] --json
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/status.js" \
  --program-id <program-id> --final-summary --program-file <accepted-program.json> \
  [--gate-evidence-dir <dir>] [--strict] --json
```

| Flag | Meaning |
| --- | --- |
| `--gates` | Evaluate the program's exit gates (read-only). Mutually exclusive with `--final-summary`. |
| `--final-summary` | Declare evidence-backed program completion (read-only). |
| `--program-file <path>` | The accepted program — the ONLY source of `exit_gates` (required by both modes; its `id` must match the receipt). |
| `--gate-evidence-dir <dir>` | Directory of live `integration:` evidence artifacts (`<check>.json` → `{ "passed": bool }`); also env `RELAY_ORCA_GATE_EVIDENCE_ROOT`. |
| `--record-proposals` | (`--gates` only) Append discovered follow-up proposals to the receipt's `follow_ups`. WITHOUT it, both modes are strictly read-only. |
| `--strict` | Turn the fail-closed conditions below into non-zero exits. Without it, both modes exit `0` with the truthful report. |

`--gates --json` keys (verbatim): `ok`, `program_id`, `receipt_path`, `prerequisites_met`,
`gates`, `follow_ups`, `blocking_reasons`. `--final-summary --json` keys (verbatim): `ok`,
`program_id`, `receipt_path`, `program_complete`, `stopped_on`, `outcomes`, `gates`,
`follow_ups`, `deferred`, `decisions`, `blocking_reasons`.

| reason_code | exit | Trigger (only under `--strict`) |
| --- | --- | --- |
| `GATES_NOT_EVALUABLE` | 70 | `--gates`/`--final-summary` before prerequisites reconcile. |
| `GATE_FAILED` | 71 | Any exit gate failed. |
| `COMPLETION_BLOCKED` | 72 | `--final-summary` and `program_complete` is false. |

Gate kinds, ordering/masking, follow-up lifecycle, decision/budget/authorization records,
the completion rule, and the stop-condition table: [gates-and-completion.md](gates-and-completion.md).

## `resume` — crash-safe, reconcile-first, idempotent resumption

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/resume.js" \
  --program-id <program-id> [--json] [--operator-handle <handle> ...] \
  [--orca-bin <path>] [--gh-bin <path>] [--repo-root <path>]
```

| Flag | Meaning |
| --- | --- |
| `--program-id`, `-p` | The accepted program's stable id (required). Resolves the receipt under the programs root. |
| `--json` | Emit the machine-readable resume report as JSON on stdout. |
| `--operator-handle <handle>` | Repeatable. An explicit operator terminal to re-dispatch/reacquire to. `resume` never creates its own terminal and never adopts one it did not receive here: if an outcome needs (re)dispatch and no handle is provided, `resume` fails closed with a `decision_required` report (`RESUME_NO_OPERATOR_HANDLE`, exit 66) and performs zero mutation. Each handle must already run an agent CLI. |
| `--orca-bin <path>` | Explicit Orca CLI override for the reconciliation reads and the restoration mutations. |
| `--gh-bin <path>` | Explicit `gh` CLI override (or env `RELAY_ORCA_GH_BIN`). |
| `--repo-root <path>` | Explicit repo root for slug derivation (defaults to the git repo of the cwd). |
| `--resolve-decision <id>` / `--resolution` / `--resolver` | (#947) Write a resolved `decision:` record up front (before reconciliation), so it persists regardless of the resume verdict. Same semantics as on `run`. |
| `--record-authorization <id>` / `--authorizer` | (#947) Write an `authorization:` record up front. |
| `--program-file <path>` | (#947) OPTIONAL — sources the decision-gate provenance (question/options/downstream_wave) when resolving a decision from resume. |
| `--help`, `-h` | Print usage. |

`resume` loads the reconstructible receipt (fail-closed codes 50–52 verbatim), then runs the
**same** live reconciliation as `status` (the imported #945 pipeline) **before any mutation**.
It then reuses valid live mappings, reacquires a lost operator terminal, and re-dispatches an
outcome **only** when ALL of: its Orca dispatch is verifiably absent, its relay side shows no
in-flight/durable work, and the wave rules allow it — through the SAME verified path as `run`
(inject → dispatch-show → prompt), persisting the receipt at the same A-series write points.
Running it twice is **idempotent**: no duplicate Orca tasks, dispatches, relay runs, fleets,
branches, or PRs can result. It **never** invokes `orca orchestration reset`, any `orca
worktree` subcommand, task deletion, or relay force-close, and it never creates Orca worktrees.

### Resume report (`--json`)

Exactly these top-level keys: `ok`, `program_id`, `receipt_path`, `runtime`, `reconciliation`
(the status-report outcome entries), `actions` (`{ outcome_id, action, reason }` where `action`
is `reused | redispatched | skipped | decision_required`), `terminals_created`,
`decision_required` (`{ reason_code, message, options }`, empty when none), `blocking_reasons`,
and `reconciliation_required` (literally `true`).

### Resume decision matrix (fail closed, no mutation)

A reconciliation result that makes resumption unsafe fails closed with a `decision_required`
report and **zero** mutation — resume creates no Orca gate, resets nothing, and deletes nothing.
The recovery options never advise `reset`, task deletion, worktree deletion, or relay
force-close (see [recovery.md](recovery.md)).

| reason_code | exit | Trigger |
| --- | --- | --- |
| `RESUME_RUNTIME_CHANGED` | 60 | Live runtime id differs from the receipt `runtime_id`. |
| `RESUME_AMBIGUOUS_STATE` | 61 | Runtime foreign/unreachable, or an outcome cannot be classified for resumption (e.g. a stale-`worker_done` inconsistency). |
| `RESUME_CONFLICTING_MAPPING` | 62 | Duplicate or contradictory (changed) mappings. |
| `RESUME_MISSING_PROVENANCE` | 63 | A live dispatch exists but the recorded dispatch context/assignee is missing. |

Receipt-layer failures re-use `50`–`52` verbatim; usage errors exit `64`.

## `stop` — coordinator-only stop

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/stop.js" \
  --program-id <program-id> [--reason <text>] [--json] [--orca-bin <path>] [--repo-root <path>]
```

| Flag | Meaning |
| --- | --- |
| `--program-id`, `-p` | The accepted program's stable id (required). Resolves the receipt under the programs root. |
| `--reason <text>` | Operator reason recorded verbatim (bounded to ≤256 chars) in the receipt's `stop_reason`. |
| `--json` | Emit the machine-readable stop report as JSON on stdout. |
| `--orca-bin <path>` | Explicit Orca CLI override for `run-stop`. |
| `--repo-root <path>` | Explicit repo root for slug derivation. |
| `--help`, `-h` | Print usage. |

`stop` loads the receipt (fail-closed codes 50–52 verbatim) and invokes the **only** mutating
Orca subcommand it may ever use — `orca orchestration run-stop` — then records a bounded stop
record (`stopped_at`, `stop_reason`) in the receipt. Only those two fields change; every other
field is byte-identical. A second stop is idempotent: it leaves the original stop record intact
and rewrites nothing. `stop` **never** terminates relay executors, deletes worktrees, closes
PRs/issues, invokes `reset`, invokes any `task-create`/`task-update`/`dispatch`/`terminal`
subcommand, or emits language claiming the program or its outcomes are cancelled/complete —
relay/fleet artifacts stay discoverable through normal relay tooling.

### Stop report (`--json`)

Exactly these top-level keys: `ok`, `program_id`, `receipt_path`, `coordinator_stopped`
(boolean from the live `run-stop` result), `stopped_at`, `stop_reason`, `blocking_reasons`. A
`run-stop` that does not succeed reports `coordinator_stopped: false` with a
`COORDINATOR_STOP_FAILED` (exit `65`) blocking reason and writes no stop record.

See [experimental-status.md](experimental-status.md) for the pilot boundary,
[capability-probe.md](capability-probe.md) for admission details, and
[recovery.md](recovery.md) for the manual decision-recovery steps.
