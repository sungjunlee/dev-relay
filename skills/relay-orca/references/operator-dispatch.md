# Operator dispatch contract (`run` intent)

`run` materializes an accepted program's wave plan into Orca orchestration tasks and dispatches
**provenance-injected relay operators**. This reference pins the operator prompt contract per
task kind, the completion payload every operator returns, the fail-closed provenance rules, and
the ownership boundary. It is the reviewer's anchor for the `run` operator surface (#944).

## Ownership boundary (binding)

- Orca workers are relay **operators**, not direct code workers. The coordinator and Orca
  terminals never edit implementation code directly. **Relay is the only creator of
  implementation worktrees and durable run manifests** — `run` never invokes any
  `orca worktree` subcommand.
- `orca orchestration reset` is never invoked on any path.
- For `integration_gate`, only the coordinator creates/adopts/resolves the canonical gate;
  the operator writes deterministic evidence and never mutates a gate or task.
- Orca `worker_done` and task status are **lifecycle signals, never completion authority**. A
  program outcome is complete only when live relay manifests, PRs/issues, and program exit gates
  confirm it. `run` always reports `reconciliation_required: true`; live reconciliation is #945.

## Prompt contract per task kind

Each prompt sources its operator surface from the plan's `recommended_route` (operator name and
mode **only**). No executor/reviewer engine name, model name, or engine-specific flag ever
appears in a prompt — engine selection is `relay-config`, resolved at relay dispatch time.

| task_kind | Operator | Prompt body |
| --- | --- | --- |
| `relay_run` | `relay` | Drive the normal relay path: readiness → plan → dispatch → review → merge. Coordinator/terminals never edit code directly. |
| `relay_fleet` | `relay-fleet` | Same relay path, plus the **already-prepared** leaf artifacts (prompt/rubric/done-criteria paths from the program contract). A fleet outcome lacking prepared leaves never reaches prompt building (the plan rejects `UNPREPARED_FLEET_LEAF`). |
| `integration_gate` | `relay-review` | **read-only** integration-gate evidence; findings become tracker follow-ups. Review completion does not authorize coordinator file edits or silent fixes. The prompt includes the deterministic report path and, after gate resolution, one explicit worker_done command. |
| `advisory_review` | `relay-review` | **read-only** advisory evidence; blocking findings triaged into tracker follow-ups. No file edits or fixes. |
| `tracker_reconciliation` | `dev-backlog` | Reconcile tracker/issue state against live relay manifests. |

`integration_gate` and `advisory_review` prompts always contain the literal token `read-only`
and never instruct file edits.

## Completion payload contract

Every operator prompt embeds the completion payload contract — the operator returns ALL of:

`program_id`, `task_id`, `outcome_id`, `orca_task_id`, `dispatch_id`, `assignee`, `relay_ids`
(request/run/fleet ids when applicable), `issue_url`, `pr_url`, `verification`,
`observed_state`, `follow_ups`.

The prompt closes with the literal sentence:

> Live reconciliation is still required; this payload is not completion evidence.

and the lifecycle note that Orca `worker_done` and task status are lifecycle signals, never
completion authority.

## Provenance verification (fail closed)

For each dispatched task, in order:

1. `orca orchestration dispatch --task <orca_task_id> --to <handle> --inject --json`. Non-zero
   exit or `ok:false` → `INJECTION_UNDELIVERED` (exit 42).
2. `orca orchestration dispatch-show --task <orca_task_id> --json` MUST carry a task id equal to
   the dispatched id, a non-null non-empty dispatch id, and a non-null non-empty assignee
   handle. Any null/empty/mismatched value → `PROVENANCE_MISMATCH` (exit 43).
3. **Only after** verification succeeds is the operator prompt delivered via one
   `orca terminal send --terminal <handle> --text <full prompt> --enter --json` (the real
   mid-2026 CLI — no `--to`, no `--task`, no stdin). The full prompt rides in a single
   `--text` value and is never split. It is never delivered before verification.

An unverified task is never reported `dispatched`. A step 1–2 failure records the task
`escalated`, dispatches no further pending task, and leaves already-verified running operators
untouched (stop semantics are #946).

## Integration-gate completion contract (#1019)

An integration operator must write the live report at the exact path supplied in the prompt,
using deterministic JSON that is bound to THIS dispatch — it MUST carry `passed`, `evidence`,
and the exact `runtime_id`/`task_id`/`dispatch_id`/`assignee` of the live dispatch (the same
required fields as the [gates-and-completion.md](gates-and-completion.md#integration-gate-lifecycle-1019)
bound shape), e.g.:

```json
{"passed":true,"evidence":"suite green","runtime_id":"<live>","task_id":"<this task>","dispatch_id":"<this dispatch>","assignee":"<this pane>"}
```

An artifact omitting any provenance field, or carrying a reused/prior-run value, fails closed
(`INTEGRATION_REPORT_PROVENANCE_MISSING` / `INTEGRATION_REPORT_PROVENANCE_MISMATCH`) and never
resolves the gate. The operator does not create or resolve the gate. The coordinator uses the shared #1016 marker to derive
the exact question and the exact options `["passed","failed"]`; it lists, creates/adopts,
and re-lists under a bounded lock. Lost create responses are recovered by re-list/adopt, while
duplicates, noncanonical gates, missing physical ids, and conflicting results stop the flow.

After fresh runtime, coordinator, task, dispatch, assignee, and report validation, the
coordinator resolves the adopted physical gate to the canonical `passed` resolution and sends
a fresh instruction. That instruction includes one copy-paste command in the real CLI shape:

```bash
orca orchestration send \
  --from <fresh-assignee> --to <current-coordinator> \
  --subject '<marker>' --body '<completion text>' \
  --type worker_done --task-id <task-id> --dispatch-id <dispatch-id> \
  --report-path <deterministic-report> --phase integration_gate --json
```

The operator runs it exactly once from the current dispatched pane. The coordinator then
re-reads `task-list` and accepts completion only when that task is `completed`. The command
never uses raw `--payload` JSON. A stale runtime/coordinator/task/dispatch/assignee/report,
unavailable gate identity, completion-delivery gap, or missing terminal transition fails closed
with the exact capability gap. No `task-update`, reset, receipt edit, or manual dispatch replay
is a repair path. Redispatch and restart regenerate every provenance field and the completion
command from fresh reads.

## Terminal acquisition — explicit handles only

`run` dispatches ONLY to operator terminals passed via a repeatable `--operator-handle`. It
NEVER creates its own terminal: a bare `orca terminal create` yields an agent-less terminal,
and `orca orchestration dispatch --inject` to such a terminal hard-fails with *"no recognized
agent detected"*. Each handle must therefore already be running an agent CLI — create one with
`orca terminal create --command "<agent-cli>" --json` and pass its handle. Invoked with zero
handles, `run` fails closed with `OPERATOR_DISPATCH_FAILED` (44) BEFORE any mutation (no
task-create, no dispatch, no terminal create); `terminals_created` is always `[]`. A handle
carries at most one active dispatched task; when ready tasks exceed available handles, the
remaining tasks stay `pending` (partial wave dispatch).

## Reason codes

| reason_code | exit | Trigger |
| --- | --- | --- |
| `ADMISSION_REJECTED` | 40 | Probe rejected or reported `admitted:false` (no mutation ran). |
| `TASK_MATERIALIZE_FAILED` | 41 | An `orca orchestration task-create` failed; earlier tasks left in place and listed. |
| `INJECTION_UNDELIVERED` | 42 | A `dispatch --inject` step failed (or the post-verification prompt hand-off failed). |
| `PROVENANCE_MISMATCH` | 43 | `dispatch-show` returned null/empty/mismatched provenance. |
| `OPERATOR_DISPATCH_FAILED` | 44 | `run` was invoked with zero `--operator-handle` (it never self-creates a terminal). Rejected upfront, before any mutation. |
| `INTEGRATION_LIFECYCLE_FAILED` | 45 | The coordinator-owned integration boundary cannot verify the current canonical gate/provenance/terminal transition safely. |

Plan-library rejections (`2`–`21`) re-raise verbatim; usage errors exit `64`.
