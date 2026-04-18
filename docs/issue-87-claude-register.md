# Issue #87 — Claude Relay-Side Registration Receipt

## Summary

`relay-dispatch --register` now supports `--executor claude` without trying to emulate Codex App internals. Codex registration still creates a real Codex App thread because Codex exposes pre-session UI state. Claude takes the honest-parity path instead: relay writes a small receipt under `~/.relay/worktrees/<wt-hash>/claude-registration.json`, and Claude Code continues to create the real session JSONL on first `claude` invocation.

## Contract

- `skills/relay-dispatch/scripts/claude-app-register.js` writes a relay-owned JSON receipt only.
- The receipt records schema version, timestamp, UUIDv7 session id, branch, title, pin, best-effort Claude CLI version, and best-effort git metadata.
- The helper never writes to `~/.claude/`. That directory remains Claude Code's responsibility.
- Re-registering the same worktree overwrites the existing receipt in place with a fresh session id and timestamp.

## Dispatch Behavior

- `dispatch.js` no longer warns that `--register` is Codex-only when the executor is Claude.
- Successful Claude registration sets `threadId` from the receipt's `sessionId`, so dispatch output and JSON stay aligned with the existing Codex result shape.
- Claude registration failures are non-fatal. Dispatch logs `Warning: claude registration failed: ...` in text mode and continues with the completed run.

## Verification

- Direct helper tests cover happy path, overwrite behavior, `RELAY_HOME` isolation, and git-missing tolerance.
- Dispatch integration coverage verifies that `--register --executor claude` no longer emits the old Codex-only warning in text mode.
