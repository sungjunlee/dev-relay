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
| Runtime-global state is empty for v0 | task-list + gate-list counts both `=== 0` and each `count` equals its own array length |
| Injected dispatch returns provenance IDs | Explicit `--smoke` create + `dispatch --inject` |

## Targeted CLI surface (mid-2026)

Read-only default:

- `orca status --json`
- `orca orchestration task-list --json`
- `orca orchestration gate-list --json`

Smoke-only (explicit `--smoke`):

- `orca orchestration task-create --spec … --task-title … --json`
- `orca orchestration dispatch --task … --to … --inject --json`
- `orca orchestration task-update --id … --status … --json`

**Never** invoked on any path: `orca orchestration reset`.

## Check order (first failure wins)

1. Binary resolution (`--orca-bin` → `PATH` → macOS bundle fallback)
2. Runtime readiness (`status --json`)
3. Orchestration availability (`task-list --json`)
4. Existing global state (`task-list` + `gate-list` counts / runtimeId consistency)
5. Optional smoke (only when `--smoke` and all prior checks passed)

Checks after a failed check may be skipped and are recorded as `skipped` in `checks[]`.

## Reason codes and exit codes

| reason_code | exit | trigger |
| --- | --- | --- |
| `BINARY_NOT_FOUND` | 30 | All resolution branches miss |
| `RUNTIME_NOT_READY` | 31 | Well-formed status fails a readiness conjunct |
| `ORCHESTRATION_UNAVAILABLE` | 32 | Orchestration absent/disabled/`ok:false` |
| `MALFORMED_OUTPUT` | 33 | Unparseable or shape-invalid JSON |
| `EXISTING_ORCHESTRATION_STATE` | 34 | Task or gate `count > 0` (never adopted) |
| `AMBIGUOUS_GLOBAL_STATE` | 35 | Non-integer `count`, a `count` that disagrees with its own array length, or `_meta.runtimeId` mismatch |
| `SMOKE_FAILED` | 36 | Smoke provenance verification failed |
| `SMOKE_CLEANUP_FAILED` | 37 | Smoke cleanup of self-created state failed |

Usage errors (unknown flags, missing args) exit `64`.

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

## Guarantees

- **D1 read-only default** — without `--smoke`, the probe spawns only `status`,
  `orchestration task-list`, and `orchestration gate-list`. It creates no Orca task,
  terminal, worktree, relay request/run, PR, or tracker issue, and writes nothing to the
  filesystem (stdout/stderr only).
- **D2 no-reset** — no code path invokes `orca orchestration reset`, including error and
  smoke-cleanup-failure paths.
- **D9 smoke** — runs only under `--smoke`, only after default checks pass; creates exactly
  one synthetic task whose title contains `relay-orca-probe-smoke`; requires non-empty
  task / dispatch / assignee IDs; cleans up only IDs it created via `task-update` to a
  terminal status; never touches pre-existing IDs and never calls reset.

## Invocation

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" --json
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" --json --smoke
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" --json --orca-bin /path/to/orca
```

See [commands.md](commands.md) for the flag table and JSON surface summary.
