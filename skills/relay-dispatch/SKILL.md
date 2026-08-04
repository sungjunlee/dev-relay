---
name: relay-dispatch
argument-hint: "<repo-path> (-b <branch> | --run-id <id>) -p <prompt> [options]"
description: Dispatch implementation tasks via worktree isolation. Use when delegating work to an executor, running background dispatches, or parallelizing independent tasks.
compatibility: Requires executor CLI, git, Node.js 18+, and macOS sandbox-exec for local executor write isolation.
metadata:
  related-skills: "relay, relay-ready, relay-plan, relay-review, relay-merge"
  keywords: "디스패치, 실행, dispatch, executor, worktree"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`.
- Files: dispatch prompt (`--prompt-file` or `--prompt`), required rubric via `--rubric-file`, optional Done Criteria file, and optional repository-relative copied files.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`.

# Relay Dispatch

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
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b feature-auth -p "..." --rubric-file rubric.yaml --network-access enabled

# Detached (recommended for long/background work; survives caller shell exit)
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b feature-auth -p "..." --rubric-file rubric.yaml --network-access enabled --detach --json

# Same-run resume after a changes-requested review
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . --run-id issue-42-20260403120000000 --prompt-file review-round-2-redispatch.md --network-access enabled

# With explicit executor
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -e codex -b feature-auth -p "..." --rubric-file rubric.yaml --network-access enabled
```

For background and parallel dispatch, see `../relay/SKILL.md` § Batch Mode (single source of truth for the parallel-fork flow).

Supported executors: `codex`, `claude`, `opencode`, `pi`, `antigravity`, `cursor`, and `cline`. Select one with `--executor`; select a model explicitly with `--model` or omit it to use the adapter provider default.

Default timeouts are `codex: 2400` and `claude/opencode/pi/antigravity/cursor/cline: 1800`. Capability negotiation and the adapter contract are documented in `references/agent-adapter-platform.md`.

## Options

The CLI has a closed option contract. Unsupported flags fail closed.

Essential flags:

- `--branch, -b` starts a new retained run; `--run-id` requests a same-run redispatch.
- `--prompt, -p` or `--prompt-file` supplies the executor prompt.
- `--rubric-file` is required for new dispatches. `--done-criteria-file` freezes a separate review anchor; otherwise the rubric is frozen as Done Criteria.
- `--executor, -e` and `--model, -m` select execution. Resume cannot replace the executor bound in `run.json`.
- `--sandbox`, `--network-access`, `--timeout`, `--reasoning`, and `--copy` configure the attempt. Copy inputs must be regular files contained by the repository.
- Provider control-plane transport is always available to the trusted CLI. `--network-access` governs model/tool networking: `disabled` requires an adapter-native deny and fails closed for adapters that cannot enforce one; `enabled` explicitly permits the adapter's network-capable tools.
- `--credential-env NAME` and `--credential-file ID=/absolute/source` explicitly opt a credential into a foreground attempt. They are repeatable, adapter-declared, and incompatible with `--detach`.
- Unattended Claude Max runs require an operator-generated `CLAUDE_CODE_OAUTH_TOKEN` selected with `--credential-env`; Relay never extracts the macOS Keychain login.
- `--fleet-id` requires typed `--ownership-json` with exactly `sprint`, `track`, and `component`; parent and ownership digest are immutable.
- `--detach` starts a detached dispatch supervisor, prints a receipt, and returns before executor completion.
- `--dry-run` is a zero-write preflight for inputs, branch, capabilities, registration support, and invocation shape. Its argv is diagnostic and must never be launched raw: production always wraps it in the host sandbox.
- Dispatch admits itself. There is no writer generation, cutover flag, or migration overlay: a new run is claimed by a non-recursive `mkdir` on its run directory, which fails closed if the directory already exists.
- `--json` returns structured output for orchestration.

The durable layout is `~/.relay/runs/<repo-slug>/<run-id>/`: immutable `run.json`, `done-criteria.md`, and `rubric.yaml`; append-only `events.jsonl`; and per-attempt prompt, log, and result artifacts. Legacy manifests, routing hints, and readiness identity flags do not participate in dispatch.

The actual executor process tree runs under a host-enforced macOS
`sandbox-exec` boundary. `workspace-write` permits writes only inside the
retained worktree, the exact attempt result artifact, and attempt-private
temp/HOME/XDG directories; read-only credential copies remain exact write denies. The exact `/dev/null` device is available only for descendant
stdio, and `read-only` omits worktree writes. The `osascript` AppleEvent entry
point, active checkouts, sibling
worktrees, home, broad temp, and other paths are never writable. Unsupported platforms fail closed before any
executor process starts; the run record, prompt, and `attempt_started` fact are already durable by then, so the
run is recoverable rather than silently unisolated.

Executor attempts intentionally cannot write linked-worktree Git administration,
objects, refs, config, or hooks. They leave reviewable dirty worktree bytes; only
the canonical `relay-recover recover` operation may commit, push, and publish them.

JSON uses snake_case. Foreground output includes `status`, `run_id`, `run_dir`, `worktree`, `attempt_id`, `host_handle`, `host_status`, `outcome`, and `inspection`. A detached launch receipt includes `status: "dispatched"`, those durable identities, `dispatcher_pid`, and the initial `inspection`. Per-attempt log paths are recorded in `attempt_started`.

### Timeout guidance

Use defaults for simple work, `--timeout 3600` when implementation plus verification needs more time, and `--timeout 5400` only for complex multi-file work with a long final gate.

## Verify Success

Treat `inspection.recommended_action` as the next-step authority. `completed` means both the durable host and adapter outcome succeeded; `failed` means either side failed. `cancelled` covers cancellation and timeout. The process exits non-zero for unsuccessful terminal outcomes.

Successful dispatches retain the worktree. A `--run-id` call first performs a read-only inspection and proceeds only when both the folded action and recommendation are exactly `redispatch`. After acquiring the run lock it repeats that inspection and requires the same action key before writing a prompt or attempt fact; terminal, stale, review, publication, merge, and operator-attention actions fail closed.

Publication is not part of dispatch. Dispatch records the executor attempt and
returns the derived action. Use `relay-recover inspect`, then the idempotent
`relay-recover recover` operation to commit, push, and create or reuse the
exact PR authorized by current facts.

Claude, Codex, OpenCode, Pi, and Cursor prompts use bound stdin transport.
Antigravity and Cline are explicit argv-visible exceptions with a 256 KiB
prompt limit and local process-list exposure. Primary review uses the same
explicit adapter credential catalog and never discovers an ambient HOME.

### Handling Failures

| Failure | Action |
|---|---|
| Timeout or cancellation | Inspect the retained worktree and typed recommendation; never treat it as completed |
| Executor or output-parse error | Read the attempt logs/result and follow the typed recommendation |
| Resume denied | Follow `inspection.recommended_action`; dispatch only admits exact `redispatch` |
| Publication / PR creation failed | Use canonical `relay-recover inspect` and idempotent `recover`; dispatch does not publish |
| Branch conflicts | Resolve in worktree or create fresh worktree from updated main |
| Network/transient error | Wait 30s, retry once. If it fails again, escalate to user |

## Recovery and operator utilities

- Any interrupted or externally changed run → inspect with canonical `relay-recover.js inspect`, then apply only its typed recommendation with `relay-recover.js recover --reason ...`; see `references/recovery-playbook.md`.
- Interrupted or externally changed runs → `references/operator-utilities.md`.

## Caveats

- `dispatch.js` exits non-zero on failure; check before review.
- Successful dispatch retains the worktree by default.
- If parallel PRs touch the same files, merge one at a time and rebase the other.
