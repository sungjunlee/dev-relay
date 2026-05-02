# Issue 389 Codex Sandbox Worktree Admin Dir

## Summary

Relay dispatch gives Codex a worktree path with `codex exec -C <worktree> --sandbox workspace-write`. Normal file edits land under that worktree, but `git add` and `git commit` write lock and index files under the worktree's real Git admin directory, usually `<main-repo>/.git/worktrees/<name>/`. That directory is outside the worktree path, so Codex needs it in the workspace-write allowlist.

This PR ships Path 1: `dispatch.js` resolves the worktree admin dir with `git -C <worktree> rev-parse --git-dir`, validates that it is under `git -C <worktree> rev-parse --git-common-dir` plus `worktrees/`, and passes it to Codex as `--add-dir <admin-dir>` for Codex `workspace-write` executions. Path 2 remains available through the existing `recover-commit.js` operator recovery path and is not enabled by default.

## Codex 0.128.0 Config Surface

Local verification in this dispatch environment:

- `codex --version` returned `codex-cli 0.128.0`.
- `codex exec --help` documents `--add-dir <DIR>` as "Additional directories that should be writable alongside the primary workspace".
- `codex exec --help` also documents `-c, --config <key=value>` for dotted config overrides parsed as TOML. Relay already uses that surface for `sandbox_workspace_write.network_access=true`.

No documented `sandbox_workspace_write.allowed_writes=[...]` key appeared in the 0.128.0 help output. The documented and observed equivalent for widening writable paths is `--add-dir <DIR>`.

## Repro Notes

A temp repo/worktree repro was attempted with both:

- no `--add-dir`
- `--add-dir <main-repo>/.git/worktrees/<worktree-name>`

Nested Codex could not complete the model step in this sandboxed dispatch environment because DNS to `chatgpt.com` failed. That means the local failure remains intermittent here rather than successfully reproduced end to end. The useful evidence is the Codex startup sandbox line:

- Without `--add-dir`: `sandbox: workspace-write [workdir, /tmp, $TMPDIR, <codex-home>/memories]`
- With `--add-dir`: `sandbox: workspace-write [workdir, /tmp, $TMPDIR, <main-repo>/.git/worktrees/<name>, <codex-home>/memories]`

That confirms Codex 0.128.0 accepts `--add-dir` and incorporates the worktree admin dir into the workspace-write allowlist before command execution. The original #332 retained relay evidence remains the canonical observed failure: `events.jsonl` recorded `new_dispatch:completed-uncommitted`, and `recover-commit` used reason `codex finished implementation but sandbox blocked git add/commit step`. The canonical stderr shape for this failure class is `fatal: Unable to create '<main-repo>/.git/worktrees/<name>/index.lock': Operation not permitted`.

## Decision Tree

Decision-tree paths from #389, kept verbatim:

If `--add-dir` IS supported and works: ship Path 1. Path 2 (`--auto-recover-commit`) becomes optional defense-in-depth — either bundle it or defer to a follow-up issue.

If `--add-dir` is NOT supported or doesn't fix the failure: ship Path 2 and document Path 1's failure mode in recovery-playbook.md.

## PR Description Draft

Summary:

- Documented the Codex 0.128.0 sandbox config surface and local repro limits.
- Added Codex-only `--add-dir <admin-dir>` argv construction for relay worktrees.
- Surfaced dispatch handoff mode as `commitMode`, including `committed in-sandbox` and `completed-uncommitted, recover-commit required`.

Decision-tree paths from #389, echoed verbatim:

If `--add-dir` IS supported and works: ship Path 1. Path 2 (`--auto-recover-commit`) becomes optional defense-in-depth — either bundle it or defer to a follow-up issue.

If `--add-dir` is NOT supported or doesn't fix the failure: ship Path 2 and document Path 1's failure mode in recovery-playbook.md.

Validation:

- `codex --version`
- `codex exec --help`
- temp worktree nested Codex sandbox probe, blocked by DNS before model execution but confirming `--add-dir` appears in the workspace-write allowlist
- `node --test tests/relay-dispatch/scripts/dispatch.test.js`
- `node --test tests/relay-dispatch/scripts/*.test.js`
