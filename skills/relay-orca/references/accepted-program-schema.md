# Accepted-program schema (v0)

`relay-orca plan` consumes exactly one **already-accepted** program/epic contract. The
contract is the boundary: relay-orca does not brainstorm, author specs, decompose issues,
or mutate the tracker. Input begins only after an operator has accepted a program with
tracker-backed outcomes and program exit gates.

The contract is engine-agnostic by construction. It carries **no** agent-engine execution
fields (no `executor`, `reviewer`, `model`, `engine`, prompt variants, or CLI selection).
Executor/reviewer selection is **relay route configuration**, resolved by `relay-config`
at operator dispatch time — not part of this schema (D11).

## Shape

```jsonc
{
  "program": {
    "id": "epic-941",                     // REQUIRED — stable program/epic identifier
    "source": "https://.../issues/941",   // program source URL or file
    "repo": "owner/name",                 // repository identity
    "tracker": "github",                  // tracker identity
    "concurrency": 2,                     // optional; default 2, hard maximum 4
    "exit_gates": ["...", "..."],         // REQUIRED — >= 1 non-empty program exit gate
    "decision_gates": [                    // optional program-level gates / auth boundaries
      { "id": "signoff", "description": "operator approves completion", "authorization": "operator" }
    ],
    "outcomes": [                          // REQUIRED — >= 1 accepted outcome
      {
        "id": "942-probe",               // REQUIRED — stable, unique; yields a stable task id
        "title": "Orca capability probe",
        "issue": 942,                     // issue reference where implementation is required
        "task_kind": "relay_run",         // REQUIRED — one of the five supported kinds
        "accepted_outcomes": ["probe merged"],  // REQUIRED — >= 1 non-empty accepted outcome
        "depends_on": [],                 // optional — outcome ids in THIS program
        "wave": 1,                         // optional — author-pinned wave (all-or-nothing)
        "decision_gate": null,             // optional per-outcome gate
        "expected_evidence": ["PR merged", "issue 942 closed"],  // optional; defaults per kind
        "leaves": []                       // relay_fleet ONLY — prepared leaf contracts
      }
    ]
  }
}
```

The root may be the program object directly or wrapped under a `program` key.

## Field rules

- `id` — required non-empty string. The stable task id is derived deterministically as
  `orca-task-<slugified-id>`; duplicate outcome ids (or ids that collide after slugging)
  are rejected.
- `exit_gates` — required, at least one non-empty string. Missing → rejection (D7b).
- `concurrency` — integer in `[1, 4]`; default `2`. Above `4` → rejection (D7g). `--concurrency`
  overrides the program value.
- `outcomes[].accepted_outcomes` — required, at least one non-empty string. Empty/absent means
  raw/vague intent → rejection (D7a).
- `outcomes[].task_kind` — one of `relay_run`, `relay_fleet`, `integration_gate`,
  `advisory_review`, `tracker_reconciliation`. Anything else → rejection (D7f); `relay_orca`
  specifically → nested-relay-orca rejection (D9).
- `outcomes[].depends_on` — outcome ids declared in the same program. Unknown references and
  self-references are rejected; a dependency cycle → rejection (D7d).
- `outcomes[].wave` — optional author-pinned wave. If any outcome declares `wave`, all must
  (positive integers). Every dependency must resolve to a strictly earlier declared wave;
  a dependency in the same (or later) wave → rejection (D7e). When no waves are declared,
  `plan` derives them by dependency leveling.
- `relay_fleet` outcomes — must carry a non-empty `leaves[]`, each leaf with non-empty
  `prompt_file`, `rubric_file`, and `done_criteria_file` (already prepared by `relay-plan` /
  `relay-fleet`). Any unprepared leaf → rejection (D7c). relay-orca never prepares leaves.

## Depth and nesting

An outcome that declares sub-orchestration (`spawns_operators: true`, `sub_program`,
`orchestrates[]`, or `depth > 1`) exceeds the allowed depth and is rejected (D9). A program
that declares itself nested under another relay-orca program (`nested: true` or
`parent_program_kind: "relay_orca"`) is rejected as nested relay-orca (D9). Maximum depth is
coordinator → relay/fleet operator → relay executor/reviewer.
