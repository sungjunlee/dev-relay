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

## Per-File Delta

- [`skills/relay-dispatch/scripts/dispatch.js`](../skills/relay-dispatch/scripts/dispatch.js) now treats `--register --executor claude` as a normal best-effort registration path instead of printing the old Codex-only warning. The Claude branch calls `registerClaudeApp(...)`, maps `sessionId -> threadId`, and keeps failure handling non-fatal.
- [`skills/relay-dispatch/scripts/claude-app-register.js`](../skills/relay-dispatch/scripts/claude-app-register.js) is the Claude-specific helper added for this issue. It writes only `~/.relay/worktrees/<wt-hash>/claude-registration.json`, captures branch/title/pin plus best-effort CLI/git metadata, and returns `{ sessionId, metadataPath }`.
- [`skills/relay-dispatch/scripts/claude-app-register.test.js`](../skills/relay-dispatch/scripts/claude-app-register.test.js) covers the receipt contract: happy path, overwrite behavior, `RELAY_HOME` isolation, and missing-git tolerance.
- [`skills/relay-dispatch/scripts/dispatch.test.js`](../skills/relay-dispatch/scripts/dispatch.test.js) adds the regression proof that text-mode Claude registration no longer emits the old Codex-only warning while still surfacing the new relay receipt-backed `threadId`.
- [`README.md`](../README.md) now documents the executor split explicitly: dispatch-time registration supports both executors, but Codex creates a real app thread while Claude writes a relay-owned receipt. It also keeps `create-worktree.js --register` scoped to Codex.

## Design Note: Why Relay Does Not Pre-Create `~/.claude/projects/`

Relay intentionally does not write Claude session files under `~/.claude/projects/`.

- Claude Code owns the on-disk session format, naming, and lifecycle for real sessions.
- Relay can safely mint a relay-owned correlation id and receipt under `~/.relay/` because that namespace is already the orchestrator contract boundary.
- Pre-creating fake Claude session JSONL would couple relay to undocumented Claude internals and risks producing misleading or stale session records if Claude changes its layout or only materializes sessions after first launch.
- The shipped behavior therefore chooses honest parity, not fake parity: dispatch gets a stable relay receipt immediately, and Claude creates the actual session record later when the operator really invokes `claude` inside the retained worktree.

## Operator Guidance

To cross-reference relay's receipt with Claude Code's real session data:

- First inspect the relay receipt at `~/.relay/worktrees/<wt-hash>/claude-registration.json`. That file is the dispatch-time audit record and contains the relay-generated `session_id`, branch, title, pin, and best-effort git metadata.
- Treat that receipt as the relay-side handoff marker, not as proof that Claude has already created a live session.
- After launching `claude` in the retained worktree, inspect Claude's real session store under `~/.claude/projects/<slug>/` and match by the same worktree/repo context plus creation time. Relay does not guarantee a filename match because Claude owns that namespace.
- If an operator needs to answer "which Claude session came from this dispatch?", start from the relay receipt, then correlate against Claude's session files by worktree path, branch context, and timestamp proximity after first invocation.

## Out of Scope: Title And Pin Semantics

- `title` and `pin` are stored in the relay receipt so dispatch output preserves the same request shape across executors.
- This issue does not make Claude Code honor relay-provided title or pin metadata inside `~/.claude/projects/`.
- This issue does not add a Claude-side resume command equivalent to Codex App thread resume.
- `create-worktree.js --register` remains Codex-only, so no promise is made here about Claude title/pin support in that standalone workflow.

## Verification

- Direct helper tests cover happy path, overwrite behavior, `RELAY_HOME` isolation, and git-missing tolerance.
- Dispatch integration coverage verifies that `--register --executor claude` no longer emits the old Codex-only warning in text mode.
