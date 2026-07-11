# Task kinds, routes, and ownership invariants

relay-orca supervises a bounded Orca task graph whose workers are relay **operators**. Each
task compiles to a recommended relay operator surface and a set of expected live evidence.
The recommended route names the operator surface **only**; the executor/reviewer engine is
relay route configuration (`relay-config`), never part of the program contract (D11).

## The five supported task kinds

| task_kind | Operator | recommended_route | read-only | Expected evidence (default) |
| --- | --- | --- | --- | --- |
| `relay_run` | `relay` | `{ operator: relay, mode: single_run }` | no | relay manifest merged; PR merged; issue closed |
| `relay_fleet` | `relay-fleet` | `{ operator: relay-fleet, mode: prepared_leaves }` | no | every fleet child terminal; fleet manifest closed |
| `integration_gate` | `relay-review` | `{ operator: relay-review, mode: integration_gate }` | yes | integration gate report; gate check passes live |
| `advisory_review` | `relay-review` | `{ operator: relay-review, mode: advisory }` | yes | advisory evidence posted; blocking findings triaged |
| `tracker_reconciliation` | `dev-backlog` | `{ operator: dev-backlog, mode: reconcile }` | yes | tracker/issue state reconciled against relay manifests |

`relay_fleet` outcomes must arrive with already-prepared leaves (`prompt_file`,
`rubric_file`, `done_criteria_file`). relay-orca never prepares leaves — that is `relay-plan`
and `relay-fleet` work.

## Ownership invariants (surfaced in every plan)

- **Operators, not code workers.** Orca workers are relay operators. Relay is the only owner
  of implementation worktrees and durable child run manifests. Orca never edits code directly.
- **Lifecycle is not completion.** Orca task status and `worker_done` are lifecycle signals,
  **not** completion authority. A program outcome is complete only when live relay manifests,
  PRs, issues, and program exit gates confirm it. `worker_done` alone is never sufficient.
- **Bounded depth.** Maximum orchestration depth is
  coordinator → relay/fleet operator → relay executor/reviewer. Nested relay-orca is
  forbidden, and any outcome that would add a deeper delegation layer is rejected (D9).
- **Immutable waves.** Dependencies compile into ordered, immutable waves; same-wave tasks are
  mutually independent. New or changed dependencies belong in a **later** wave — v0 never
  rewrites an active wave in place.

## Wave compilation

`plan` compiles `depends_on` edges into ordered waves. When outcomes pin `wave` values, those
declared waves are honored and validated (every dependency must sit in a strictly earlier
wave). When no waves are declared, `plan` derives them by dependency leveling: an outcome's
wave is `1 + max(wave of its dependencies)`. Either way, same-wave independence is guaranteed,
which is why a same-wave dependency is a hard rejection (D7e) rather than a silent reorder.
