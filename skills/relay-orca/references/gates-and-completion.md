# Exit gates, follow-up waves, and evidence-backed completion (#947)

Two READ-ONLY `status` modes layer program-level assurance on the #945 reconciliation.
`status --gates` evaluates the accepted program's exit gates; `status --final-summary`
declares evidence-backed program completion. Both land INSIDE the existing five intents —
there is no new intent and no new top-level entry point. Follow-up acceptance flows through
the existing `plan`/`run` on an operator-extended program JSON; decision/authorization
records are additive receipt fields written only via explicit operator flags on
`run`/`resume`.

## Exit gates are input artifacts

Exit gates come ONLY from the accepted program's `exit_gates` array (already required by
the frozen plan compiler). `status --gates` evaluates each gate **verbatim** — no code path
invents, renames, drops, or weakens a gate, and the gates listed in every report are
byte-equal to the program file's entries. Because the gates are input, `status --gates`
requires `--program-file <accepted-program.json>`; its program id must match the receipt's
program id.

## Gate kinds (pinned `kind:` prefix convention)

Each gate is keyed by a pinned, verbatim prefix on the gate string:

| Prefix | Meaning | Evidence source |
| --- | --- | --- |
| `integration:<check>` | a named check / evidence artifact must pass **live** | a version-1 identity-bound artifact under `--gate-evidence-dir`; never task/worker status |
| `advisory:<ref>` | advisory evidence posted + blocking findings triaged (reuses the #945 advisory contract) | the reconciled `advisory_review` outcomes |
| `tracker:<ref>` | tracker reconciliation clean for the program's issues | no reopened issue / duplicate-or-lost mapping / unreconciled back-pointer in the reconciliation |
| `decision:<id>` | an explicit, resolved user decision record exists | the receipt's `decisions[]` (six provenance keys) |
| `budget:<counter> <= <int>` | a numeric ceiling on a receipt-recorded counter | derived counters (`tasks_created`, `dispatches_performed`, `waves_dispatched`) |
| `authorization:<id>` | an explicit authorization record exists | the receipt's `authorizations[]` |

A gate string **without a recognized prefix evaluates as `unevaluable`** — NEVER as passed
(fail closed) — with a diagnostic naming it. A `budget:` ref that does not parse, or names
an unknown counter, is likewise `unevaluable`.

### Generic integration evidence trust contract (#1046)

`integration:<check>` is a generic named exit check. It is not an implicit
`integration_gate` outcome and does not inherit that outcome's `task_id`, `dispatch_id`, or
`assignee` contract. A newly accepted program that declares an integration gate must set
`integration_evidence_version: 1` and declare exactly one entry in
`integration_evidence[]` for the exact raw `<check>` ref. The declaration must contain the
accepted `program_id`, a non-empty `runtime_id` equal to the receipt runtime, the exact raw
`check_ref`, and the verification binding. The artifact repeats those fields and is accepted
only when all identity fields and the full verification binding match the declaration.

The binding contains `input_sha256`, `result_sha256`, and `passed`; `binding_sha256` is the
SHA-256 of their canonical, lexicographically keyed JSON object. A timestamp, mtime,
`passed:true` by itself, free-form `evidence`, sanitized basename, or lifecycle outcome name
is never authority. The artifact filename includes the full SHA-256 of the raw ref, so `a/b`
and `a-b` cannot share storage. Unsafe refs, duplicate declarations, duplicate artifacts,
malformed identities, and path aliases fail closed through the existing gate state/message
fields.

The real closure topology remains explicit: `integration:full-suite` binds the generic check
artifact while the separate `integration-main-suite` outcome retains its own lifecycle
provenance. Status does not infer one identity from the other. Older identity-less programs
and artifacts are read only as fail-closed legacy input; they cannot yield
`program_complete:true`.

Gate states (verbatim enum): `passed`, `failed`, `not_yet_evaluable`, `awaiting_decision`,
`unevaluable`.

## Evaluation ordering and the masking rule

- **Prerequisite (ordering).** Exit gates evaluate ONLY after **every** accepted outcome
  reconciles `complete_with_evidence` via the #945 classifier. Before that, every gate
  reports `not_yet_evaluable` with the blocking outcomes listed in `blocking_reasons`.
- **Masking rule.** A failing integration gate can NEVER be masked by Orca task completion.
  Gate results derive **exclusively** from live evidence (checks, artifacts, tracker,
  decision/authorization records, receipt counters) — never from task or `worker_done`
  status. Even with every Orca task completed and every outcome durably complete, a failing
  integration gate keeps the program NOT complete and the gate `failed`.

## Decision records preserve full provenance

A `decision:` gate resolves ONLY against a decision record carrying ALL of (verbatim keys):
`question`, `options` (array), `resolution`, `resolver`, `resolved_at`, `downstream_wave`
(int|null). Records live in the receipt under `decisions`. `run`/`resume` write a decision
record ONLY from an explicit operator flag — never automatically:

```bash
run.js --program-file <program.json> --resolve-decision <id> --resolution "<text>" --resolver "<handle>"
resume.js --program-id <id> --program-file <program.json> --resolve-decision <id> --resolution "<text>" --resolver "<handle>"
```

The `question`/`options`/`downstream_wave` provenance is sourced from the program's declared
`decision_gates[<id>]`; `resolution`/`resolver` come from the flags; `resolved_at` is
stamped at write time. An unresolved decision gate reports `awaiting_decision` and blocks
completion. Missing any provenance key → the record is invalid → gate `unevaluable` (fail
closed), diagnostic naming the missing key.

## Budget and authorization records

- **Budget.** `budget:` gates compare a receipt-recorded counter against the gate's ceiling.
  Counters are DERIVED from the receipt mapping (a recorded `orca_task_id` = created, a
  recorded `dispatch_id` = dispatched, distinct dispatched waves = waves dispatched); an
  explicit `counters` object overrides per counter. Under ceiling → `passed`; at/over →
  `failed` with BOTH numbers in the message.
- **Authorization.** `authorization:` gates require an explicit authorization record
  (`authorizations[]`), written only via `--record-authorization <id> --authorizer <handle>`
  on `run`/`resume`. Absent → `awaiting_decision`-equivalent state, never passed.

## Follow-up proposals are advisory until accepted

When gate evaluation or reconciliation discovers implementation work, `status` records a
PROPOSED follow-up: `{ "id", "source_gate" | "source_outcome", "description",
"proposed_wave": <next wave int>, "status": "proposed" }` in the report.

- Proposals are **ADVISORY**: no code path creates issues, dispatches work, merges, deploys,
  or closes tracker items from a proposal.
- **Acceptance is an OPERATOR act outside the skill**: file the tracker issue, append the
  outcome to the program JSON as a **NEW LATER wave** with a stable new outcome id, and
  re-run `plan`/`run`. The frozen compiler already rejects same-wave dependencies and cycles
  and requires prepared fleet leaves, so follow-up waves inherit those protections
  (`SAME_WAVE_DEPENDENCY`, `UNPREPARED_FLEET_LEAF` re-raise verbatim).
- A PROPOSED follow-up that targets accepted scope blocks completion; a follow-up recorded
  with `"status": "deferred"` is listed separately (a `deferred` section) and does not block.

## Integration-gate lifecycle (#1019)

`integration_gate` is a coordinator-owned terminal boundary. The read-only integration
operator writes deterministic live evidence; it never creates or resolves an Orca gate.
The coordinator must supply an explicit current `--coordinator-handle` and verify that it is
present in the live terminal set from a read-only `orca terminal list --json` query on every run,
resume, redispatch, and restart. A failed/unparseable query or absent handle fails closed with
`INTEGRATION_COORDINATOR_PROVENANCE_MISSING` before any lifecycle mutation. A recognized
structured coordinator field, when present in a payload, remains an optional feature-detection
check; a mismatch still fails closed as `INTEGRATION_COORDINATOR_PROVENANCE_MISMATCH`, while
absence is not a failure. A receipt, history entry, prior completion message, or stale assignee is
never a source for coordinator identity.

The payload shapes targeted here were observed with `ORCA_APP_VERSION=1.4.148`: `status --json`
has `result.app`, `result.runtime`, and `result.graph` without coordinator identity; a
`dispatch-show --preamble --from <assignee> --json` dispatch row carries `id`, `task_id`,
`assignee_handle`, status/failure/timestamp fields, and `preamble` is a plain string. The preamble
is never parsed as a coordinator object or used as sole authority; text that names the assignee or
contradicts the live handle cannot override liveness.

The physical gate id is not caller-selectable in the installed Orca CLI, so the stable
logical identity is exactly:

```text
verified task id + "Integration evidence for relay-orca: <program-segment>/<outcome-id> passed?" + ["passed","failed"]
```

The coordinator holds a bounded per-program/outcome lock, performs `gate-list` first, and
creates only when zero exact canonical gates exist. It always re-lists after `gate-create`,
including a non-zero or lost response, then adopts exactly one physical id. One exact gate is
adopted. Multiple exact gates, any other gate on the dedicated task, a missing physical id,
or conflicting/noncanonical results fail closed with no further mutation. A generic
`status=resolved` is not a passed integration result without the canonical resolution.

The lifecycle ordering is terminal and one-way:

```text
verified dispatch
  -> canonical gate create/adopt
  -> operator writes <outcome-id>.json with {"passed":true,"evidence":"...",
       "runtime_id":"<live>","task_id":"<this task>","dispatch_id":"<this dispatch>",
       "assignee":"<this pane>"}
  -> fresh runtime/coordinator-terminal/task/dispatch/assignee/report revalidation
       (the report's runtime_id/task_id/dispatch_id/assignee MUST match the live dispatch;
        a reused or prior-run artifact fails closed and never resolves the gate)
  -> coordinator resolves that physical gate to passed
  -> fresh completion instruction
  -> operator sends explicit worker_done exactly once
  -> coordinator re-reads task-list and requires status=completed
```

The evidence path is deterministic, so the same path is reused across runtimes, dispatches,
and restarts. Each artifact is therefore **bound to the lifecycle that produced it**: it must
carry `runtime_id`, `task_id`, `dispatch_id`, and `assignee` matching the freshly verified
live provenance. A missing or contradicting field fails closed
(`INTEGRATION_REPORT_PROVENANCE_MISSING` / `INTEGRATION_REPORT_PROVENANCE_MISMATCH`) **before**
gate inspection or resolution, with zero lifecycle mutation. A restart of the SAME dispatch
re-reads its own artifact and still matches, so crash recovery is unaffected.

`resume` advances an integration gate only for outcomes that are wave-eligible under the same
wave blanket `planResume` applies AND whose planned action is `reused` or `redispatched` —
the two actions that leave a currently verified live dispatch behind. Receipt `dispatch_id` /
`assignee` strings alone are not proof of a live dispatch. A pending later-wave, an
undispatched, or a `skipped`/`decision_required` integration task is left untouched — no lock,
no Orca read, no mutation.

The bounded lifecycle lock records its owner pid. A lock whose owner is **provably gone**
(signal 0 reports exactly `ESRCH`) is reclaimed automatically by rename-then-remove, so an
abandoned lock never needs manual deletion and racing reclaimers cannot delete a newly
acquired lock. A live owner, a foreign-user owner (`EPERM`), and any malformed, unreadable, or
absent owner record are never stolen — that contention still times out fail-closed. There is
no mtime-lease fallback: an old mtime is not evidence that the owner is gone.

The completion instruction contains a concrete command in the authoritative shape, with
`--to <current-coordinator>`, `--type worker_done`, `--task-id`, `--dispatch-id`,
`--report-path`, `--phase integration_gate`, and `--json`; `orca orchestration send` resolves
and validates the sender from the invoking terminal, so `--from` is reserved for impersonation
and omitted. It does not use raw `--payload` JSON. If gate identity, coordinator/dispatch/report provenance, completion
delivery, or the terminal transition cannot be expressed by the installed contract, the
coordinator reports the exact missing capability and stops. There is no `task-update`, reset,
receipt-edit, or manual-dispatch-replay fallback.

`status --final-summary` treats an active integration task, missing/pending/failed canonical
gate, duplicate/noncanonical gate, generic resolved result, and conflicting result as
`orca_lifecycle_failure`, even when durable evidence and exit-gate artifacts are green.
Durable evidence remains completion authority; Orca task state and `worker_done` only prove
that the lifecycle handoff reached its required terminal state.

### The `--record-proposals` boundary

Proposals are written to the receipt (under `follow_ups`) ONLY by
`status --gates --record-proposals` (an explicit flag). Without it, `status --gates` /
`status --final-summary` stay strictly READ-ONLY — proposals appear in the report only, and
the receipt is byte-identical. `--record-proposals` is valid only with `--gates`.

## Completion declaration

`status --final-summary` declares `program_complete: true` ONLY when: every accepted outcome
is `complete_with_evidence` AND every exit gate evaluates `passed` AND no outcome is
`escalated`/`inconsistent`/`stale_missing`/`awaiting_decision` AND no PROPOSED follow-up
targets accepted scope. The summary is REPRODUCIBLE from live state — no generated
timestamps or randomness — and links, per outcome: outcome id, relay run/fleet ids, issue
URL, PR URL, verification evidence names, decision records touching it, and its final state.

### Stop conditions → `stopped_on`

When completion cannot be declared, the most-severe blocking condition becomes `stopped_on`
(a single token); `blocking_reasons` lists them all.

| Stop condition | `stopped_on` |
| --- | --- |
| tracker/receipt graph ambiguous | `graph_ambiguous` |
| relay run/fleet escalated / inconsistent | `relay_escalated` |
| Orca injection/lifecycle failure | `orca_lifecycle_failure` |
| integration gate failed | `integration_gate_failed` |
| budget ceiling reached | `budget_ceiling_reached` |
| advisory/tracker gate failed | `gate_failed` |
| a gate is unevaluable | `gate_unevaluable` |
| human decision required (decision/authorization awaiting) | `awaiting_decision` |
| unaccepted follow-up discovered | `unaccepted_follow_up` |
| accepted outcomes still incomplete | `outcomes_incomplete` |

## Fail-closed exit codes (70-range)

| reason_code | exit | trigger |
| --- | --- | --- |
| `GATES_NOT_EVALUABLE` | 70 | `--gates`/`--final-summary` before prerequisites reconcile, under `--strict` |
| `GATE_FAILED` | 71 | any exit gate failed, under `--strict` |
| `COMPLETION_BLOCKED` | 72 | `--final-summary --strict` and `program_complete` is false |

Without `--strict`, these situations exit 0 with the truthful report (information is the
product, matching `status`'s house rule). Receipt-layer failures reuse 50–52; usage is 64.

## Report surfaces

- `status --gates --json` top-level keys (verbatim): `ok`, `program_id`, `receipt_path`,
  `prerequisites_met`, `gates`, `follow_ups`, `blocking_reasons`. Each gate:
  `{ gate, kind, state, evidence, message }`.
- `status --final-summary --json` top-level keys (verbatim): `ok`, `program_id`,
  `receipt_path`, `program_complete`, `stopped_on`, `outcomes`, `gates`, `follow_ups`,
  `deferred`, `decisions`, `blocking_reasons`.

Every excerpt is bounded; neither report generates timestamps or randomness; plain `status`
(no mode flag) output stays byte-identical to the shipped #945/#946 shape.
