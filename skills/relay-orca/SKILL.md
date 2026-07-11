---
name: relay-orca
description: EXPERIMENTAL, explicit-only program-altitude coordinator. On explicit operator request, compile an already-accepted program/epic contract into bounded, read-only Orca wave plans supervising relay and relay-fleet operators. NOT for ordinary relay, relay-fleet, delegation, implementation, or planning requests.
compatibility: Requires Node.js 18+. Runtime modes (run/status/resume/stop) additionally require the experimental Orca orchestration surface and are gated on the capability probe.
argument-hint: plan --program-file <accepted-program.json>
metadata:
  related-skills: relay, relay-fleet, relay-plan, relay-dispatch, relay-review, relay-merge, dev-backlog
  keywords: relay-orca, orca program, program coordinator, accepted program, wave plan, program altitude
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`.
- Files: an already-accepted program/epic contract as JSON (`--program-file`). Schema: [references/accepted-program-schema.md](references/accepted-program-schema.md).
- Script: `${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/plan.js` (read-only wave-plan compiler).

# relay-orca

> EXPERIMENTAL and opt-in. relay-orca is a supervised program controller pilot, not an autonomous software factory, and not an implicit dependency of ordinary relay use. See [references/experimental-status.md](references/experimental-status.md).

## Use when

- You have an **already-accepted** program/epic contract (stable id, tracker-backed accepted outcomes, program exit gates) and want it compiled into bounded, ordered operator waves — invoked explicitly.
- You want a read-only preview of the wave plan, decision gates, and expected evidence before any dispatch.

## Do not use when

- Decomposing raw or ambiguous intent, authoring specs, or splitting an epic into issues — that is upstream product/planning work; relay-orca never brainstorms or mutates the tracker.
- Completing one tracker-backed outcome — use `relay`.
- Fanning out already-planned independent leaves — use `relay-fleet`.
- Authoring a single rubric/dispatch prompt — use `relay-plan`.

relay-orca is **explicit-only**. It must never be auto-selected from ordinary relay, relay-fleet, delegation, implementation, or planning requests; the OpenAI agent interface pins `allow_implicit_invocation: false`.

## Intents

relay-orca exposes exactly five intents. Only `plan` is implemented in this leaf; the runtime intents are contract-only here and are delivered in a later leaf (#944), gated on the Orca capability probe.

| Intent | Status | Purpose |
| --- | --- | --- |
| `plan` | implemented (read-only) | Compile an accepted program into an immutable wave plan. |
| `run` | contract-only (#944) | Dispatch provenance-injected relay/fleet operators for a plan. |
| `status` | contract-only (#944) | Derive live status from Orca + relay + GitHub + exit-gate evidence. |
| `resume` | contract-only (#944) | Resume a coordinator from a reconstructible receipt without resetting Orca. |
| `stop` | contract-only (#944) | Stop the coordinator only; never kill relay runs or discard durable state. |

Command tables and flag semantics: [references/commands.md](references/commands.md).

## Input Contract

`plan` reads one accepted-program JSON contract. The minimum contract is a stable program `id`, non-empty `exit_gates`, and a non-empty `outcomes[]` array where each outcome carries a stable `id`, a supported `task_kind`, non-empty `accepted_outcomes`, and optional `depends_on`/`wave`. The schema carries **no** agent-engine execution fields — executor/reviewer selection is relay route configuration (see [references/accepted-program-schema.md](references/accepted-program-schema.md) and [references/task-kinds.md](references/task-kinds.md)).

Supported task kinds: `relay_run`, `relay_fleet`, `integration_gate`, `advisory_review`, `tracker_reconciliation`.

## Commands

Compile an accepted program into a wave plan (read-only; writes only to stdout):

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/plan.js" \
  --program-file /tmp/accepted-program.json \
  --json
```

Override the coordinator concurrency ceiling (default 2, hard maximum 4):

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/plan.js" \
  --program-file /tmp/accepted-program.json \
  --concurrency 3 \
  --json
```

`plan` is READ-ONLY: it creates no Orca task or terminal, no relay request/run/worktree, no PR, and no issue, and writes nothing outside stdout/stderr. On rejection it exits with a distinct non-zero code per reason. Rejection matrix and exit codes: [references/commands.md](references/commands.md).

## Ownership invariants

- Orca workers are relay **operators**, not direct code workers; relay owns all implementation worktrees and durable run manifests.
- Orca task status and `worker_done` are **lifecycle signals, not completion authority** — program completion is proven from live relay/GitHub/exit-gate evidence.
- Maximum orchestration depth is coordinator → relay/fleet operator → relay executor/reviewer. Nested relay-orca and deeper delegation are rejected.

Full operator contract, topology, and recovery detail: [references/task-kinds.md](references/task-kinds.md) and [references/experimental-status.md](references/experimental-status.md).
