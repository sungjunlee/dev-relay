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
| `AMBIGUOUS_GLOBAL_STATE` | 35 | Bad counts or `_meta.runtimeId` mismatch |
| `SMOKE_FAILED` | 36 | Smoke provenance (task/dispatch/assignee) failed |
| `SMOKE_CLEANUP_FAILED` | 37 | Smoke cleanup of self-created state failed |

Usage errors exit `64`.

## Runtime intents (contract-only in this leaf)

`run`, `status`, `resume`, and `stop` are defined by the skill contract but are **not
implemented here**. They are delivered in a later leaf (#944) and gated on the Orca capability
probe (`probe-orca.js`). See [experimental-status.md](experimental-status.md) for the pilot
boundary and [capability-probe.md](capability-probe.md) for admission details.
