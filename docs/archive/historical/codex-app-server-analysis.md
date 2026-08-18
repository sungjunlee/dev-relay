# Codex App-Server Analysis

Analysis of `codex-plugin-cc` (OpenAI's Codex plugin for Claude Code) and implications for dispatch.js.

**Date**: 2026-03-31
**Source**: `references/codex-plugin-cc`

## Architecture Comparison

| | dispatch.js (current) | codex-plugin-cc |
|---|---|---|
| **Invocation** | `codex exec` (one-shot CLI) | `codex app-server` (JSON-RPC over stdio) |
| **Approval bypass** | `--full-auto` + prompt prefix hack | `approvalPolicy: "never"` at protocol level |
| **Progress** | Poll log file size / process CPU | Real-time notifications (`item/started`, `item/completed`) |
| **Result collection** | Raw text from `-o` file | Structured `TurnCaptureState` with typed fields |
| **Error detection** | 0 bytes + no changes heuristic | Protocol-level error notifications |
| **Session** | Fresh every time | `thread/resume` for continuation |
| **Isolation** | Git worktree | Codex sandbox (no worktree) |
| **Timeout** | `execFileSync` timeout | None (gap in plugin) |
| **Silent failure** | Detected (dispatch.js is better here) | Trusts protocol status |
| **Multi-executor** | Executor-agnostic (`EXECUTOR_CLI` map) | Codex-only |

## Key Findings

### 1. Root Cause of Dispatch Stalls

Globally-installed skills (e.g. `brainstorming` SKILL.md with HARD-GATE) instruct the model to wait for user approval before implementing. `codex exec --full-auto` sets approval to `on-request`, not `never`. In non-interactive mode, the model stops at "Waiting on your approval" and the session ends.

**Current fix**: `[NON-INTERACTIVE DISPATCH]` prompt prefix (commit `619bfe0`).
**Proper fix**: `approvalPolicy: "never"` via app-server protocol.

### 2. app-server Is Superior for Codex

Almost every aspect improves: approval bypass, progress tracking, structured output, session resume, error detection. The only cost is Codex-specific coupling.

### 3. Multi-Executor Trade-off

`codex app-server` is a Codex-only protocol. Claude Code and Gemini CLI don't offer equivalent JSON-RPC servers. Migrating dispatch.js to app-server means maintaining separate communication layers per executor.

**Recommendation**: Keep exec-based dispatch as the common interface. Optionally add app-server as a Codex-specific enhanced path.

## Applicable Improvements (by priority)

### Immediate: Process Group Kill

```js
// Current: kill(pid) — may leave child processes
// Better: kill(-pid, "SIGTERM") — signals entire process group
process.kill(-pid, "SIGTERM");
```

### Short-term: Structured Output Schema

`codex exec` doesn't support `outputSchema`, but the prompt can request JSON output and dispatch.js can validate the structure.

### Medium-term: app-server Migration (Codex only)

Replace `execFileSync("codex", ["exec", ...])` with:
1. Spawn `codex app-server`
2. `thread/start` with `approvalPolicy: "never"`
3. `turn/start` with prompt
4. Listen for notifications (progress, file changes, errors)
5. Await `turn/completed`

Benefits: real-time progress (no idle guessing), protocol-level approval bypass (no prompt hack), session resume, structured results.

### Long-term: Broker for Warm Starts

Unix socket proxy keeps one `codex app-server` alive across multiple dispatches. Eliminates per-invocation startup cost for sequential dispatch patterns (e.g. Release 11: #231–#236).

## Plugin Reference

Key source files in `references/codex-plugin-cc/plugins/codex/scripts/`:

- `lib/codex.mjs` — execution model, turn capture, notification handling
- `lib/app-server.mjs` — JSON-RPC client, process spawn, broker
- `codex-companion.mjs` — CLI dispatcher (task, review, status, cancel)
- `lib/tracked-jobs.mjs` — job lifecycle, progress reporting
- `lib/process.mjs` — `terminateProcessTree` pattern
