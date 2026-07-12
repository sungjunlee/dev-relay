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
| `--operator-handle <handle>` | Repeatable. An explicit operator terminal handle to dispatch to. With none, `run` creates its own terminals via `orca terminal create` and records them. |
| `--orca-bin <path>` | Explicit Orca CLI override — passed to the capability probe and used for all orchestration calls. |
| `--help`, `-h` | Print usage. |

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
| `OPERATOR_DISPATCH_FAILED` | 44 | No valid operator target remained for an eligible task (terminal create yielded no usable handle). |

A `42`/`43` failure records the failing task `escalated`, dispatches no further pending task,
and does not touch already-verified running operators (stop semantics are #946). Plan-library
rejections re-raise codes `2`–`21`; usage errors exit `64`. Full operator prompt contract and
provenance rules: [operator-dispatch.md](operator-dispatch.md).

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
| `RECEIPT_REPO_MISMATCH` | 52 | The receipt `repo.slug` does not match the current repo. |

Usage errors exit `64`. A successfully derived view exits `0` even when it is full of
`inconsistent`/`stale_missing` outcomes; runtime mismatch and unreachable Orca/GitHub degrade
to diagnostics rather than failing.

## Runtime intents (contract-only in this leaf)

`run` (#944) and `status` (#945) are implemented. `resume` and `stop` remain defined by the
skill contract but **not implemented here** — they are delivered in #946 and gated on the same
Orca capability probe (`probe-orca.js`). See [experimental-status.md](experimental-status.md)
for the pilot boundary and [capability-probe.md](capability-probe.md) for admission details.
