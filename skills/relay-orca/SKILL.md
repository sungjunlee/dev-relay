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
- Script: `${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js` (fail-closed Orca capability probe).
- Script: `${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/run.js` (admission-gated provenance-injected operator dispatch).
- Script: `${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/status.js` (read-only live reconciler over receipt + relay + GitHub + Orca).

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

relay-orca exposes exactly five intents. `plan` (read-only), `run` (admission-gated operator dispatch), and `status` (read-only live reconciler) are implemented; the remaining runtime intents are contract-only here and delivered in a later leaf, gated on the Orca capability probe.

| Intent | Status | Purpose |
| --- | --- | --- |
| `plan` | implemented (read-only) | Compile an accepted program into an immutable wave plan. |
| `run` | implemented (#944) | Dispatch provenance-injected relay/fleet operators for a plan. |
| `status` | implemented (#945) | Derive a read-only live program view from receipt + relay + GitHub + Orca. |
| `resume` | contract-only (#946) | Resume a coordinator from a reconstructible receipt without resetting Orca. |
| `stop` | contract-only (#946) | Stop the coordinator only; never kill relay runs or discard durable state. |

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

Admit a local Orca runtime before runtime intents (default read-only; optional `--smoke`):

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" --json
```

Probe rationale, guarantees, and reason codes: [references/capability-probe.md](references/capability-probe.md).

Dispatch provenance-injected operators for an accepted program (admission-gated; never creates an Orca worktree or invokes reset):

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/run.js" \
  --program-file /tmp/accepted-program.json \
  --operator-handle term-a --operator-handle term-b \
  --json
```

`run` compiles through the frozen plan library, requires probe admission before any mutation, materializes wave-1 tasks, and dispatches with fail-closed provenance verification. `run` also persists a minimal, versioned, atomically-written **receipt** (identity/mapping only) under `~/.relay/programs/<repo-slug>/<program-id>/`. Flags, run report shape, partial-wave semantics, and reason codes 40–44: [references/commands.md](references/commands.md) and [references/operator-dispatch.md](references/operator-dispatch.md).

Derive a read-only live program view from the receipt + relay manifests + GitHub + Orca (no mutation of any kind):

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/status.js" \
  --program-id epic-941 \
  --json
```

`status` reconciles durable truth (relay manifests, PRs/issues) against Orca runtime signals — `worker_done` is never completion evidence. Report shape, the state taxonomy, the nine detector codes, and reason codes 50–52: [references/commands.md](references/commands.md) and [references/receipt-and-status.md](references/receipt-and-status.md).

## Ownership invariants

- Orca workers are relay **operators**, not direct code workers; relay owns all implementation worktrees and durable run manifests.
- Orca task status and `worker_done` are **lifecycle signals, not completion authority** — program completion is proven from live relay/GitHub/exit-gate evidence.
- Maximum orchestration depth is coordinator → relay/fleet operator → relay executor/reviewer. Nested relay-orca and deeper delegation are rejected.

Full operator contract, topology, and recovery detail: [references/task-kinds.md](references/task-kinds.md) and [references/experimental-status.md](references/experimental-status.md).
