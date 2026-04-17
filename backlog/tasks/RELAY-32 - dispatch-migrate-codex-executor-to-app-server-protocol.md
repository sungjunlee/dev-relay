---
id: RELAY-32
title: 'dispatch: migrate Codex executor to app-server protocol'
status: To Do
labels: []
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Context

dispatch.js uses `codex exec` (one-shot CLI) to run tasks. OpenAI's codex-plugin-cc uses `codex app-server` (JSON-RPC over stdio), which provides:

- **Protocol-level approval bypass** (`approvalPolicy: "never"`) — replaces the `[NON-INTERACTIVE DISPATCH]` prompt prefix hack
- **Real-time progress tracking** — notifications for each action (editing, verifying, etc.) — eliminates the "is it idle?" guessing problem
- **Structured output** — typed `TurnCaptureState` with file changes, commands, errors
- **Session resume** — `thread/resume` to continue interrupted work

## Current State (updated 2026-04-05)

As of #65, dispatch.js supports multiple executors via `EXECUTOR_CLI` map + executor-specific branches. Claude Code executor was added alongside Codex. The exec-based pattern works for both.

Timeout handling was improved in #67 (completed-with-warning for partial work). This reduces but doesn't eliminate the progress visibility gap — we still can't tell if a timed-out executor made useful progress until after it exits.

**Remaining value of app-server migration:**
- Real-time progress notifications (the main win)
- Protocol-level sandbox/approval config (cleaner than prompt prefix)
- Session resume for interrupted work

**Reduced urgency because:**
- Multi-executor architecture already works (#65)
- Timeout partial-work handling is in place (#67)
- This is Codex-specific — only benefits one executor path

## Proposal

Add `codex app-server` as an enhanced execution path for the Codex executor, alongside the existing `codex exec` path:

1. Spawn `codex app-server` as child process
2. JSON-RPC handshake (`initialize`)
3. `thread/start` with `approvalPolicy: "never"`, `sandbox`, `cwd`
4. `turn/start` with prompt
5. Stream notifications for progress
6. Await `turn/completed`, collect structured results
7. Clean shutdown

Keep `codex exec` as fallback for simplicity and for environments where app-server isn't available.

## References

- Analysis: `docs/codex-app-server-analysis.md`
- Key source: `references/codex-plugin-cc/plugins/codex/scripts/lib/codex.mjs`
- Key source: `references/codex-plugin-cc/plugins/codex/scripts/lib/app-server.mjs`

## Effort

Medium-large — new JSON-RPC client, notification handler, structured result collection.
