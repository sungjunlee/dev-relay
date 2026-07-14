# relay-orca recovery — `resume`/`stop` decision handling

`resume` is **reconcile-first and fail-closed for runtime restoration**: it loads the
reconstructible receipt, runs the SAME live reconciliation as `status` before restoring an Orca
dispatch, and only then restores what is safe (reuse valid mappings, reacquire a lost operator
terminal, re-dispatch a verifiably-absent, relay-clean wave-1 outcome, or advance an equivalent
later-wave outcome after every earlier wave is `complete_with_evidence`, through the same verified
path — always to an explicitly provided `--operator-handle`, never a self-created terminal). The
explicit `--map-relay-run` intake described below is the narrow exception: it validates and atomically
records supervised coordination metadata before live reconciliation. **"Verifiably absent" means a live
`dispatch-show` read for that task, taken during the reconciliation pass, reported NO dispatch —
a null `dispatch_id` in the receipt alone NEVER qualifies.** In the crash window (a
`dispatch --inject` landed a live dispatch but the receipt write recording it never happened),
the receipt id is null yet a live dispatch is present; re-injecting would duplicate operator work,
so that case fails closed as `RESUME_MISSING_PROVENANCE` (exit 63) instead of re-dispatching. When
the reconciliation shows a state that makes resumption unsafe, `resume` performs **zero** mutation
and emits a `decision_required` report with a bounded exit code. This reference is the operator
anchor for those decisions.

None of the steps below are performed automatically by the skill. The skill **never** resets
Orca, deletes a task, removes a worktree, deletes a branch/PR, force-closes a relay run, or
creates its own operator terminal — on any path, including every failure path. Its runtime
mutations on a safe outcome are limited to `orca orchestration dispatch --inject` and `orca
terminal send`, both against a terminal the operator provided via `--operator-handle`; explicit
operator-record and relay-run-mapping flags may atomically update receipt metadata. If
an outcome needs (re)dispatch and no handle was provided, `resume` fails closed with
`RESUME_NO_OPERATOR_HANDLE` (exit 66) and mutates nothing. `stop`'s only mutation is
`orca orchestration run-stop`.

## Reading a `decision_required` report

`resume --json` emits `decision_required: [{ reason_code, message, options }]` and exits with the
matching code. `options` are bounded strings, each naming a concrete operator command or this
reference — never a destructive action. Resolve the decision by hand, then re-run `resume`.

### `RESUME_RUNTIME_CHANGED` (exit 60) — live runtime id ≠ receipt

The Orca runtime was restarted (or replaced): the live `runtime_id` no longer matches the
receipt, so every recorded `orca_task_id`/`dispatch_id`/terminal belongs to a runtime that is
gone. Bounded steps:

1. Inspect the live view: `node scripts/status.js --program-id <id> --json`.
2. Confirm — from live relay manifests, PRs, and issues — which outcomes already have durable
   work, so a fresh run cannot duplicate it.
3. Only then, against the new runtime, re-run `node scripts/run.js --program-file <program>` for
   the outcomes that are genuinely unstarted. Leave in-flight relay runs alone.

### `RESUME_AMBIGUOUS_STATE` (exit 61) — foreign/unreachable runtime or an unclassifiable outcome

Either the runtime carries orchestration tasks not marked for this program (`foreign_state`), the
runtime is unreachable, or an outcome is `inconsistent` (e.g. a stale `worker_done` with an open
PR / non-terminal manifest — see [receipt-and-status.md](receipt-and-status.md)). Bounded steps:

1. Inspect: `node scripts/status.js --program-id <id> --json` and read the diagnostics.
2. For a foreign runtime, verify no unrelated orchestration program is running before acting.
3. For an `inconsistent` outcome, drive the outcome to a decided durable state through the
   **normal relay path** (review → merge, or escalate), then re-run `resume`. Do not force it.

### `RESUME_CONFLICTING_MAPPING` (exit 62) — duplicate or changed mapping

Two receipt entries share an `orca_task_id`/relay run id, or a recorded dispatch id drifted away
from the live one. Bounded steps:

1. Inspect: `node scripts/status.js --program-id <id> --json` (`DUPLICATE_MAPPING` /
   `MISSING_DISPATCH` diagnostics name the conflicting ids).
2. Determine which mapping reflects the live dispatch (`orca orchestration dispatch-show --task
   <orca_task_id> --json`) and correct the receipt mapping by hand.
3. Re-run `resume`.

### `RESUME_MISSING_PROVENANCE` (exit 63) — live dispatch without recorded provenance

A live `dispatch-show` read reports a dispatch **present** for a mapped task, but the receipt's
recorded provenance is incomplete — either the `assignee` is missing (so `resume` cannot verify
which terminal owns the live dispatch), or **both the `dispatch_id` and `assignee` are absent**
(the crash window: `dispatch --inject` landed a live dispatch but the receipt write that records it
never happened). In every case a live dispatch already exists, so `resume` will **not** re-inject —
that would duplicate operator work. Bounded steps:

1. Read the live dispatch: `orca orchestration dispatch-show --task <orca_task_id> --json`.
2. Restore the missing `dispatch_id`/`assignee` in the receipt to match the live dispatch.
3. Re-run `resume` — the outcome now reads back as a valid live mapping and is reused.

### `RESUME_NO_OPERATOR_HANDLE` (exit 66) — an outcome needs (re)dispatch but no handle was given

Reconciliation found at least one outcome that is safe to re-dispatch or whose operator terminal
must be reacquired, but the invocation provided no `--operator-handle`. `resume` never creates its
own terminal (a self-created terminal has no recognized agent and cannot accept `--inject`), so it
performs **zero** mutation and asks for a terminal. Bounded steps:

1. Create an operator terminal running an agent CLI: `orca terminal create --command "<agent-cli>" --json`.
2. Re-run `resume` with that terminal handle:
   `node scripts/resume.js --program-id <id> --operator-handle <handle> --json`.
3. Provide one handle per outcome that needs a fresh operator surface; a shortfall leaves the
   excess outcomes untouched for a follow-up resume.

## Supervised relay run mapping intake

Operator-driven relay work is adopted into the receipt only through an explicit, supervised
mapping. Before changing coordination metadata, live-verify all three durable facts: the intended
relay run manifest is terminal, its PR is `MERGED`, and its tracker issue is `CLOSED`. Then run:

```bash
node scripts/resume.js --program-id <id> --program-file <program> --map-relay-run <outcome_id>=<run_id> --json
```

The accepted program supplies the outcome's declared issue, and the manifest filename supplies
the exact run id. The batch is rejected without changing the receipt when any mapping fails:

- `RESUME_MAP_TARGET_INVALID` (exit 67): the outcome is unknown, its task kind cannot consume a
  relay run mapping, or the accepted outcome has no declared issue.
- `RESUME_MAP_RUN_NOT_FOUND` (exit 68): no runs-root manifest filename exactly matches the run id.
- `RESUME_MAP_ISSUE_MISMATCH` (exit 69): the manifest issue differs from the accepted outcome issue.
- `RESUME_CONFLICTING_MAPPING` (exit 62): the run belongs to another receipt task or the target
  already names a different run.

This intake is explicit-only and never automatic. Back-pointer discovery can propose a candidate,
but neither `status` nor flagless `resume` adopts it. The mapping records coordination metadata;
the next live reconciliation remains the only authority for `complete_with_evidence`.

## Corrupt or global task-graph recovery

- **Corrupt / missing receipt** (`RECEIPT_NOT_FOUND` 50, `RECEIPT_CORRUPT` 51,
  `RECEIPT_REPO_MISMATCH` 52): the receipt is reconstructible coordination metadata, not a source
  of truth. Never hand-edit it into validity blindly — re-derive it. Confirm the program's real
  state from live relay manifests, PRs, and issues via `status`, then re-run `run` from the
  accepted-program contract to rewrite a fresh atomic receipt. Invoke from the same repo (or pass
  `--repo-root`) that produced the receipt.
- **Foreign / ambiguous global task graph**: relay-orca is single-program-per-runtime in v0. If
  the runtime carries another program's orchestration tasks, resolve that program first; do not
  adopt or reset the shared runtime from `resume`.

## Destructive manual actions — OUTSIDE automatic skill behavior

> The following are **destructive** and are **never** performed by `resume` or `stop` on any
> path. They are listed here only so an operator who chooses to perform them does so knowingly
> and by hand. The skill will not do them for you and does not recommend them as automatic
> recovery.

- `orca orchestration reset` — wipes runtime orchestration state. Never run by the skill.
- Orca task deletion / `orca orchestration task-*` deletes — never run by the skill.
- Any `orca worktree` subcommand / worktree removal — relay owns implementation worktrees.
- relay run force-close, branch deletion, or PR/issue closure — durable relay state; use the
  normal relay tooling (`relay-merge`, `dev-backlog`) deliberately, never as a resume side effect.

If a recovery seems to require one of these, stop and treat it as a manual, audited operator
decision — not a step `resume`/`stop` will take for you.
