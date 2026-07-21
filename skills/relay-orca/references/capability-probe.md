# Orca capability probe

The capability probe (`scripts/probe-orca.js`) is the **authoritative** admission gate for
relay-orca runtime intents. A version string alone cannot prove that task creation, injected
dispatch context, lifecycle IDs, or runtime readiness behave as relay-orca expects. The
targeted mid-2026 Orca CLI also exposes **no version subcommand** (`orca version` → "Unknown
command"; `orca --version` prints usage), so version is best-effort only and never blocks
admission. The orchestration surface is experimental and evolving — **revalidate this probe
on Orca upgrades**.

## Why probe over minimum-version

| Claim a version string cannot prove | What the probe verifies |
| --- | --- |
| Desktop app / runtime graph is ready | `orca status --json` readiness conjuncts |
| Orchestration commands exist and are enabled | `orchestration task-list --json` |
| Runtime-global state has no **unverified** program residue | task-list active count is zero; with explicit prior-program contexts, only rows covered by recomputed closed-program proofs are filtered |
| Injected dispatch returns provenance IDs | Explicit `--smoke --smoke-to <live-handle>` create + `dispatch --inject` to that handle |

## Targeted CLI surface (mid-2026)

Read-only default:

- `orca status --json`
- `orca orchestration task-list --json`
- `orca orchestration gate-list --json`

Smoke-only (explicit `--smoke --smoke-to <handle>`):

- `orca orchestration task-create --spec … --task-title … --json`
- `orca orchestration dispatch --task … --to <live-handle> --inject --json`
- `orca orchestration task-update --id … --status failed --json`

**Never** invoked on any path: `orca orchestration reset`.

Real CLI constraints the probe honors:

- `task-update --status` accepts only `pending, ready, dispatched, completed, failed, blocked`
  (never `cancelled`). Smoke cleanup terminalizes the synthetic task as `failed`.
- `dispatch --inject` requires a **live** terminal with a recognized agent CLI. A synthetic
  handle can never satisfy inject, so smoke always takes an operator-supplied `--smoke-to`.

## Check order (first failure wins)

1. Binary resolution (`--orca-bin` → `PATH` → macOS bundle fallback). A candidate
   is a hit only when it is a **regular, executable file**; anything that is not
   (missing, a directory, or non-executable) is a **miss**, not a short-circuit —
   resolution falls through to `PATH` and then the bundle, and `BINARY_NOT_FOUND`
   is raised only when all three ordered branches miss.
2. Runtime readiness (`status --json`)
3. Orchestration availability (`task-list --json`)
4. Existing global state (`task-list` + `gate-list` counts / runtimeId consistency), then optional explicit historical-proof filtering
5. Optional smoke (only when `--smoke --smoke-to <handle>` and all prior checks passed)

Checks after a failed check may be skipped and are recorded as `skipped` in `checks[]`.

## Active vs terminal task filtering

Real `task-list` continues to return historical `completed` / `failed` tasks indefinitely.
Admission counts only **active** (non-terminal) task states as existing orchestration state:

| Status | Admission effect |
| --- | --- |
| `pending`, `ready`, `dispatched`, `blocked` | Blocks (`EXISTING_ORCHESTRATION_STATE`) |
| `completed`, `failed` | Ignored (historical; do not brick later probes) |
| missing / unknown / malformed | Fail-closed (`AMBIGUOUS_GLOBAL_STATE`) |

Without a prior-program context, gate list ambiguity and any non-empty live gate count still
fail closed. The `existing_state.tasks` field reports the **active** task count used for
admission in that frozen path.

### Explicit prior-program contexts

`--prior-program-context <context.json>` is repeatable on both `probe-orca.js` and
`run.js`. A context is a read-only locator, not a completion claim:

```json
{
  "schema": 1,
  "repo_root": "/absolute/path/to/repo",
  "accepted_program": { "path": "/path/accepted-program.json" },
  "canonical_receipt": { "path": "/path/receipt.json" },
  "trusted_evidence": {
    "durable_outcomes": { "path": "/path/durable-outcomes.json" },
    "generic_integration": { "path": "/path/generic-integration.json" }
  }
}
```

Every attempt rereads these files and recomputes Leaf 1's `verifyClosedProgram` against
the one live status/task-list/gate-list snapshot. Context success/proof bits are ignored.
Missing, duplicate, malformed, unreadable, cross-repository, contradictory, or
cross-runtime inputs fail closed with `AMBIGUOUS_GLOBAL_STATE` (35). No context keeps the
original #942 policy byte-for-byte: terminal completed/failed tasks are ignored and any
gate or active task blocks.

With contexts, only a uniquely owned task whose proof mapping and exact
`relay-orca: <program-segment>/<outcome>` marker agree and whose live state is exactly
`completed` is exempt. A gate is exempt only when its unique physical id links to that
exempt task and the recomputed proof includes it; all other terminal/foreign/orphaned or
unresolved rows remain in the post-filter `existing_state.tasks` / `existing_state.gates`
counts. Multiple contexts are sorted by program identity, and task/gate rows are sorted by
physical id before classification.

### Remediation (no automatic reset)

When active tasks or gates block admission:

1. Finish or clear the **active** tasks/gates manually, then re-probe.
2. Historical completed/failed leftovers alone are not blocking.
3. When a clean slate is appropriate between programs, the operator may run a **scoped**
   manual `orca orchestration reset --tasks` (state fully enumerated first). **relay-orca
   never invokes `orca orchestration reset` automatically** — not on admission failure,
   smoke cleanup, or any other path.

## Reason codes and exit codes

| reason_code | exit | trigger |
| --- | --- | --- |
| `BINARY_NOT_FOUND` | 30 | All resolution branches miss |
| `RUNTIME_NOT_READY` | 31 | Well-formed status fails a readiness conjunct, or `status` exits non-zero with shape-valid stdout |
| `ORCHESTRATION_UNAVAILABLE` | 32 | Orchestration absent/disabled/`ok:false` |
| `MALFORMED_OUTPUT` | 33 | Unparseable or shape-invalid JSON |
| `EXISTING_ORCHESTRATION_STATE` | 34 | Active task/gate residue, or validly classified rows not covered by a recomputed closed-program proof |
| `AMBIGUOUS_GLOBAL_STATE` | 35 | Contradictory counts, unknown/missing identity or status, duplicate/malformed/foreign attribution, unreadable or cross-repository context, proof/runtime mismatch, or inconsistent runtime ids |
| `SMOKE_FAILED` | 36 | Smoke provenance verification failed |
| `SMOKE_CLEANUP_FAILED` | 37 | Smoke cleanup of self-created state failed |

Usage errors (unknown flags, missing args, bare `--smoke` without `--smoke-to`) exit `64`.

When smoke provenance **and** cleanup both fail, `blocking_reasons` retains **both**
`SMOKE_FAILED` and `SMOKE_CLEANUP_FAILED` (primary cause is not overwritten); exit stays
`36` (`SMOKE_FAILED`).

A `count` that contradicts its own array (e.g. `count:0` alongside a non-empty
`tasks`/`gates`) is treated as ambiguous rather than trusted — the probe never
adopts state the count claims is absent.

## Bounded execution (no hangs)

Every Orca invocation runs with a finite `timeout` (default 10000 ms) and a
bounded `maxBuffer`, so a hung or wedged CLI cannot stall the probe forever. A
timed-out command is killed and flows through the **same** per-check failure
classification as any non-zero exit or spawn error of that command (a hung
`status` → `MALFORMED_OUTPUT`; a hung `task-list`/`gate-list` →
`ORCHESTRATION_UNAVAILABLE`), so the stable JSON envelope is still emitted with
`admitted:false`. Set `RELAY_ORCA_PROBE_TIMEOUT_MS` (positive integer; invalid
values are ignored and fall back to the default) to shorten the budget in tests.

## Bounded message excerpts (D8)

Every subprocess-derived value that lands in a human-readable `message` or
`remediation` string — readiness conjuncts (`runtime.state`, `runtimeId`,
`graph.state`), `_meta.runtimeId` mismatch pairs, smoke task/dispatch/assignee
IDs, the smoke leftover-cleanup ID, and any `stderr`/parse excerpt — is rendered
through a single helper that truncates so the returned excerpt is at most 256
characters **total, including** the appended `…` marker (255 input chars + the
marker). A hung or adversarial CLI therefore cannot inflate a blocking message
or inject extra lines into it; the eleven top-level JSON keys, reason codes, and
exit codes are unaffected.

## Guarantees

- **D1 read-only default** — without `--smoke`, the probe spawns only `status`,
  `orchestration task-list`, and `orchestration gate-list`. With explicit contexts it also
  rereads only the locator, accepted-program, canonical receipt, and trusted evidence files.
  It creates no Orca task, terminal, worktree, relay request/run, PR, or tracker issue, and
  writes nothing to the filesystem.
- **D2 no-reset** — no code path invokes `orca orchestration reset`, including error and
  smoke-cleanup-failure paths. Scoped manual reset remains an operator remediation step only.
- **D9 smoke** — runs only under `--smoke --smoke-to <live-handle>`, only after default
  checks pass; creates exactly one synthetic task whose title contains `relay-orca-probe-smoke`;
  dispatches `--inject` to the **supplied** live handle (never a synthetic probe handle);
  requires non-empty task / dispatch / assignee IDs with assignee matching `--smoke-to`;
  cleans up only IDs it created via `task-update --status failed`; never touches pre-existing
  IDs and never calls reset. Bare `--smoke` fails fast (exit 64) with guidance before any
  smoke task state is created. When `task-create` returns ok but no task id, the probe fails
  `SMOKE_FAILED` with `cleaned_up:false` (no id to clean) and its remediation names the
  `relay-orca-probe-smoke` title marker so the operator can find any untracked synthetic task
  via `orca orchestration task-list`.

## Invocation

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" --json
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" --json \
  --smoke --smoke-to <live-agent-terminal-handle>
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" --json --orca-bin /path/to/orca
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" --json \
  --orca-bin /path/to/orca --prior-program-context /path/prior-context.json
```

`--smoke-to` must name a terminal already running a recognized agent CLI (e.g. claude,
codex, gemini, droid). See [commands.md](commands.md) for the flag table and JSON surface
summary.
