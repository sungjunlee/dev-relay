# Agent Adapter Platform

Relay keeps executor and primary-review capabilities explicit. Every supported
harness can dispatch; only harnesses that can return the strict primary verdict
contract are registered as reviewers. Adapter capability is the only runtime
authorization surface.

## Executor Contract

Every executor in `skills/relay-dispatch/scripts/executors/` exports:

| Field | Purpose |
| --- | --- |
| `cliBinary` | Binary used for availability and version preflight. |
| `defaultTimeout` | Default dispatch timeout in seconds. |
| `validateExecutionMode(...)` | Reject or warn when requested containment is unavailable. |
| `buildExecCommand(...)` | Build a non-interactive argv-only command. |
| `finalizeResult(...)` | Normalize the executor result. |
| `register(...)` | Optional app/thread registration. |
| `probe(...)` | Deterministic CLI/environment probe. |

Register each harness in the adapter registry and keep executor/model selection
explicit at dispatch time.

## Primary Reviewer Contract

Reviewer adapters live at
`skills/relay-review/scripts/invoke-reviewer-<name>.js` and return stdout JSON
matching `REVIEWER_VERDICT_JSON_SCHEMA`:

```bash
node invoke-reviewer-<name>.js \
  --repo <repoPath> --prompt-file <promptPath> --json [--model <provider/model>]
```

`review-runner.js` is the normal entry point. Direct invocation is for adapter
debugging. A new run binds an explicit model when provided, otherwise the
adapter default; resumed runs use their immutable manifest binding. Historical
`model_hints` data is inert and never participates in selection.

| Reviewer | Invocation and isolation |
| --- | --- |
| `codex` | Ephemeral native read-only review with schema output. |
| `claude` | Bare/no-session-persistence mode with read-only tool access. |
| `opencode` | Prompt-only read-only review plus dirty-worktree guard. |
| `pi` | `read,grep,find,ls` tool allowlist plus dirty-worktree guard. |
| `antigravity` | `agy` CLI only; `agy --sandbox` plus dirty-worktree guard. |
| `cursor` | Agent ask mode; parses the wrapper `result` field. |

Cline remains a dispatch executor. It is not a primary reviewer because a
healthy strict-verdict live canary has not established that capability.
OpenCode and Antigravity review timeouts are controlled by
`RELAY_OPENCODE_REVIEW_TIMEOUT` and `RELAY_ANTIGRAVITY_REVIEW_TIMEOUT`.
Antigravity primary review remains experimental until a healthy live reviewer
canary returns strict verdict JSON within timeout. Its dispatch canary must make
a minimal repository change to recoverable/reviewable state; a documented CLI limitation is not healthy success.

## Capability Matrix

| Adapter | Dispatch | Primary review | App registration |
| --- | --- | --- | --- |
| `codex` | Yes | Yes | Codex task registration |
| `claude` | Yes | Yes | Claude session registration |
| `opencode` | Yes | Yes | No |
| `pi` | Yes | Yes | No |
| `antigravity` | Yes, experimental | Yes, experimental | No |
| `cursor` | Yes, experimental | Yes, experimental | Cursor chat registration |
| `cline` | Yes | No | No |

All commands are built as argv arrays. Adapters that cannot represent requested
sandbox, read-only, or network behavior must fail closed or surface an explicit
capability warning. A fake-binary test is contract evidence, not proof that a
live provider integration is healthy.

## New Adapter Checklist

1. Add the seven-field executor contract and register its descriptor.
2. Add a reviewer script only when strict primary verdict output is supported.
3. Add executor argv/probe tests and primary-review tests when applicable.
4. Keep missing-CLI probes deterministic: `{error, raw: null}`.
5. Document containment and adapter capability limitations.
6. Add concise operator examples.

## Examples

```bash
# Explicit executor and model
node skills/relay-dispatch/scripts/dispatch.js . \
  --executor pi --model openai/gpt-5 -b issue-42 -p "..."

# Explicit primary reviewer and model
node skills/relay-review/scripts/review-runner.js \
  --repo . --run-id "$RUN_ID" --reviewer pi \
  --reviewer-model openai/gpt-5 --json

# Cline is dispatch-only
node skills/relay-dispatch/scripts/dispatch.js . \
  --executor cline --model cline-pass/glm-5.2 -b issue-42 -p "..."
```
