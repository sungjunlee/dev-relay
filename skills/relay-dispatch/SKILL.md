---
name: relay-dispatch
argument-hint: "<repo-path> (-b <branch> | --run-id <id>) -p <prompt> [options]"
description: Dispatch implementation tasks via worktree isolation. Use when delegating work to an executor, running background dispatches, or parallelizing independent tasks.
compatibility: Requires executor CLI, git, and Node.js 18+ on a trusted local development host.
metadata:
  related-skills: "relay, relay-ready, relay-plan, relay-review, relay-merge"
  keywords: "디스패치, 실행, dispatch, executor, worktree"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`.
- Files: dispatch prompt (`--prompt-file` or `--prompt`), required rubric via `--rubric-file`, optional Done Criteria file, and optional repository-relative copied files.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`.

# Relay Dispatch

The public `/relay` source gate must select the route before this command. It
requires a Git checkout, permits no configured remotes for local Reviewed
Result delivery, and accepts only the exact supported GitHub remote shape for
the GitHub route. Dispatch itself never initializes Git or selects a forge.

## Use when

- Delegating implementation to an executor (`codex`, `claude`, `opencode`, `pi`, `antigravity`, `cursor`, `cline`) via worktree isolation
- Resuming a same-run after a `changes_requested` review
- Running background or parallel dispatches for independent tasks

## Do not use when

- Authoring rubrics or planning — use `relay-plan`
- Reviewing executor output — use `relay-review`
- Task lacks frozen Done Criteria — anchor it via `relay-ready` first

## Usage

```bash
# Foreground (blocking — simple tasks, default executor: codex)
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b feature-auth -p "..." --rubric-file rubric.yaml

# Detached (recommended for long/background work; survives caller shell exit)
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b feature-auth -p "..." --rubric-file rubric.yaml --detach --json

# Same-run resume after a changes-requested review
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . --run-id issue-42-20260403120000000 --prompt-file review-round-2-redispatch.md

# With explicit executor
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -e codex -b feature-auth -p "..." --rubric-file rubric.yaml
```

For background and parallel dispatch, see `../relay/SKILL.md` § Batch Mode (single source of truth for the parallel-fork flow).

Supported executors: `codex`, `claude`, `opencode`, `pi`, `antigravity`, `cursor`, and `cline`. Select one with `--executor`; select a model explicitly with `--model` or omit it to use the adapter provider default.

Default timeouts are `codex: 2400` and `claude/opencode/pi/antigravity/cursor/cline: 1800`. Capability negotiation and the adapter contract are documented in `references/agent-adapter-platform.md`.

## Options

The CLI has a closed option contract. Unsupported flags fail closed.

Essential flags:

- `--branch, -b` starts a new retained run; `--base <ref>` selects the publication base (`origin/HEAD` by default; required when origin/HEAD is missing). `--run-id` requests a same-run redispatch.
- `--prompt, -p` or `--prompt-file` supplies the executor prompt.
- `--rubric-file` is required for new dispatches. `--done-criteria-file` freezes a separate review anchor; otherwise the rubric is frozen as Done Criteria.
- `--executor, -e` and `--model, -m` select execution. On `--run-id`, omit `--executor` to use the immutable executor bound in `run.json`; an explicit different executor fails before reading the prompt or writing an attempt. `--model` remains per-attempt.
- `--network-access`, `--timeout`, `--reasoning`, and `--copy` configure the attempt. Copy inputs must be regular files contained by the repository.
- Provider control-plane transport is always available to the trusted CLI. Tool networking defaults to `enabled` for trusted-local dispatch; the explicit `--network-access disabled` advanced request requires an adapter-native deny and fails closed for adapters that cannot enforce one. The retired public `--sandbox` flag fails as an unknown option; dispatch always uses writable-worktree semantics and the adapter/phase owns its truthful native filesystem request.
- CLI authentication, HOME, XDG config, and supported token variables come from the operator's ambient local environment. Credential selector flags were removed and fail as unknown options; Relay never copies auth files or records their paths.
- Adapters retain their actual invocation tools and native capability declarations. Prompt wording never controls dispatch admission or selects a different outcome/verification contract.
- `--fleet-id` requires typed `--ownership-json` with exactly `sprint`, `track`, and `component`; parent and ownership digest are immutable.
- `--detach` starts a detached dispatch supervisor, prints a receipt, and returns before executor completion.
- `--dry-run` is a zero-write preflight for inputs, branch, capabilities, registration support, and invocation shape. Its argv is diagnostic and must never be launched raw: production always uses the host supervisor.
- Dispatch admits itself. There is no writer generation, cutover flag, or migration overlay: a new run is claimed by a non-recursive `mkdir` on its run directory, which fails closed if the directory already exists.
- `--json` returns structured output for orchestration.

The durable layout is `~/.relay/runs/<repo-slug>/<run-id>/`: immutable `run.json`, `done-criteria.md`, and `rubric.yaml`; append-only `events.jsonl`; and per-attempt prompt, log, and result artifacts. Retired routing hints and readiness identity flags do not participate in dispatch.

Relay runs directly on the trusted local host; it has no filesystem admission
or profile compiler. Dispatch always runs with writable-worktree semantics and
lets each adapter/phase request its own truthful native filesystem isolation
(Codex requests `workspace-write`, Cursor requests `enabled`, Claude enables
its documented Bash sandbox, and Antigravity keeps its declared flag). Pi,
OpenCode, and Cline run directly. Foreground and dry-run JSON return the
non-durable `filesystem_isolation` requested/effective diagnostic; missing or
declaration-only isolation never rejects dispatch. Use an external container
or VM for a hostile-worker threat model.

Executor attempts preserve immutable input staging, executable binding,
timeout/cancellation, inherited-scope cleanup, and durable facts. Relay itself
never commits, publishes on the GitHub route, records verification, or closes a
local result; those lifecycle actions belong to canonical `relay-recover recover`.

JSON uses snake_case. Foreground output includes `status`, `run_id`, `run_dir`, `worktree`, `attempt_id`, `host_handle`, `host_status`, `outcome`, `inspection`, and non-durable `filesystem_isolation` plus `loopback_listen`. A detached launch receipt includes `status: "dispatched"`, those durable identities, `dispatcher_pid`, and the initial `inspection`. Per-attempt log paths are recorded in `attempt_started`.

### Timeout guidance

Use defaults for simple work, `--timeout 3600` when implementation plus verification needs more time, and `--timeout 5400` only for complex multi-file work with a long final gate.

## Verify Success

Treat `inspection.recommended_action` as the next-step authority. `completed` means both the durable host and adapter outcome succeeded; `failed` means either side failed. `cancelled` covers cancellation and timeout. The process exits non-zero for unsuccessful terminal outcomes.

Successful dispatches retain the worktree. A `--run-id` call first performs a read-only inspection and proceeds only when both the folded action and recommendation are exactly `redispatch`. After acquiring the run lock it repeats that inspection and requires the same action key before writing a prompt or attempt fact; terminal, stale, review, publication, merge, and operator-attention actions fail closed.

Publication is not part of dispatch. Dispatch records the executor attempt and
returns the derived action. Use `relay-recover inspect`, then the idempotent
`relay-recover recover` operation to commit and publish the exact GitHub PR
revision when that route is selected, or to close a reviewed local result.

Claude, Codex, OpenCode, Pi, and Cursor prompts use bound stdin transport.
Antigravity and Cline are explicit argv-visible exceptions with a 256 KiB
prompt limit and local process-list exposure. Primary review inherits the
operator's ambient HOME/XDG CLI session just as dispatch does; Relay neither
discovers nor copies authentication files.

### Handling Failures

| Failure | Action |
|---|---|
| Timeout or cancellation | Inspect the retained worktree and typed recommendation; never treat it as completed |
| Executor or output-parse error | Read the attempt logs/result and follow the typed recommendation |
| Resume denied | Follow `inspection.recommended_action`; dispatch only admits exact `redispatch` |
| Publication / local closure failed | Use canonical `relay-recover inspect` and idempotent `recover`; dispatch does not publish or close |
| Branch conflicts | Resolve in worktree or create fresh worktree from updated main |
| Network/transient error | Wait 30s, retry once. If it fails again, escalate to user |

## Recovery and operator utilities

- Any interrupted or externally changed run → inspect with canonical `relay-recover.js inspect`, then apply only its typed recommendation with `relay-recover.js recover --reason ...`; see `references/recovery-playbook.md`.
- Interrupted or externally changed runs → `references/operator-utilities.md`.

## Caveats

- `dispatch.js` exits non-zero on failure; check before review.
- Successful dispatch retains the worktree by default.
- If parallel PRs touch the same files, merge one at a time and rebase the other.
