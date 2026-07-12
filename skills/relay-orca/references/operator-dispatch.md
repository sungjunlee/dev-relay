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
| `integration_gate` | `relay-review` | **read-only** integration-gate evidence; findings become tracker follow-ups. Review completion does not authorize coordinator file edits or silent fixes. |
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
3. **Only after** verification succeeds is the operator prompt delivered (via `orca terminal
   send`, prompt on stdin). It is never delivered before verification.

An unverified task is never reported `dispatched`. A step 1–2 failure records the task
`escalated`, dispatches no further pending task, and leaves already-verified running operators
untouched (stop semantics are #946).

## Terminal acquisition

`run` dispatches only to handles it (a) received via a repeatable `--operator-handle`, or (b)
created itself via `orca terminal create` this invocation (each created handle recorded in the
report's `terminals_created`). A handle carries at most one active dispatched task; when ready
tasks exceed available handles, remaining tasks stay `pending` (partial wave dispatch).

## Reason codes

| reason_code | exit | Trigger |
| --- | --- | --- |
| `ADMISSION_REJECTED` | 40 | Probe rejected or reported `admitted:false` (no mutation ran). |
| `TASK_MATERIALIZE_FAILED` | 41 | An `orca orchestration task-create` failed; earlier tasks left in place and listed. |
| `INJECTION_UNDELIVERED` | 42 | A `dispatch --inject` step failed (or the post-verification prompt hand-off failed). |
| `PROVENANCE_MISMATCH` | 43 | `dispatch-show` returned null/empty/mismatched provenance. |
| `OPERATOR_DISPATCH_FAILED` | 44 | No valid operator target remained for an eligible task. |

Plan-library rejections (`2`–`21`) re-raise verbatim; usage errors exit `64`.
