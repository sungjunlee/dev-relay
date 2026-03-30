---
name: relay-dispatch
argument-hint: "<repo-path> -b <branch> -p <prompt> [options]"
description: Dispatch implementation tasks via worktree isolation. Creates a git worktree, runs an executor (Codex by default) with a contract prompt, and collects results. Use when delegating work, running background dispatches, or parallelizing independent tasks.
compatibility: Requires executor CLI (e.g., codex), git, and Node.js 18+.
metadata:
  related-skills: "relay, relay-plan, relay-review, relay-merge"
---

# Relay Dispatch

Create a worktree and dispatch a task to an executor.

## Usage

```bash
# Foreground (blocking — simple tasks, default executor: codex)
${CLAUDE_SKILL_DIR}/scripts/dispatch.js . -b feature-auth -p "..." --copy-env

# With explicit executor
${CLAUDE_SKILL_DIR}/scripts/dispatch.js . -e codex -b feature-auth -p "..."
```

For background and parallel dispatch, see "Background & Parallel" section below.

## Options

| Flag | Description |
|---|---|
| `--branch, -b` | Branch name (required) |
| `--prompt, -p` | Task prompt (include Context + Done Criteria + self-review) |
| `--prompt-file` | Read prompt from file (for large prompts) |
| `--executor, -e` | Executor: `codex` (default) |
| `--model, -m` | Model override |
| `--sandbox` | `workspace-write` (default) or `read-only` |
| `--copy-env` | Copy `.env` to worktree |
| `--copy <files>` | Additional files to copy |
| `--timeout` | Timeout in seconds (default: 1800) |
| `--register` | Register session in executor's app (keeps worktree) |
| `--dry-run` | Show plan without executing |
| `--json` | Structured JSON output (for background dispatch) |

Creates worktree → runs executor → collects result.
Exits with non-zero code on failure.

### Timeout guidance

| Task type | Timeout | Rationale |
|---|---|---|
| Simple implementation | `1800` (default) | No self-review needed |
| With self-review loop | `3600` | Codex iterates 2-3 times |
| Complex / multi-file | `5400` | Deep implementation + thorough self-review |

## Verify Success

After dispatch completes, confirm before proceeding to review:

```bash
# Check dispatch result (JSON output includes status field)
# status: "completed" → proceed to relay-review
# status: "failed" → check error, re-dispatch or fix manually

# Verify PR exists
gh pr list --head <branch> --json number,url,title
```

### Handling Failures

| Failure | Action |
|---|---|
| Timeout | Increase `--timeout` or split task into smaller pieces |
| Codex error (non-zero exit) | Read result file for error details; fix prompt and re-dispatch |
| No commits made | Prompt was unclear or task was impossible; revise and re-dispatch |
| No PR created | Codex may have committed but not pushed PR; check `git log` in worktree |
| Branch conflicts | Resolve in worktree or create fresh worktree from updated main |
| Network/transient error | Wait 30s, retry once. If it fails again, escalate to user |
| ENOBUFS (buffer overflow) | Codex output exceeded buffer. Work is likely complete — dispatch reports `completed-with-warning`. Check worktree for uncommitted changes, commit manually if needed, then proceed to review |

## Background & Parallel

### Background dispatch

Run dispatch asynchronously so the orchestrator can continue other work (planning, reviewing, user interaction) while the executor runs.

> **Platform examples — async dispatch:**
> Claude Code: `Bash(run_in_background=true)` | Codex: shell `&` or platform async | Other: any non-blocking execution

```bash
${CLAUDE_SKILL_DIR}/scripts/dispatch.js . -b task-42 --prompt-file tasks/42.md --json --timeout 3600
# Run this command in the background using your platform's async mechanism
# When executor finishes → proceed to relay-review
```

### Parallel dispatch (independent tasks)

Launch multiple independent dispatches concurrently using the same async mechanism:

```bash
# Each dispatch runs independently in the background
${CLAUDE_SKILL_DIR}/scripts/dispatch.js . -b task-42 --prompt-file tasks/42.md --json
${CLAUDE_SKILL_DIR}/scripts/dispatch.js . -b task-43 --prompt-file tasks/43.md --json
# Each completes independently → review each PR via relay-review
```

## `register-codex.js` — Codex App integration

For manual Codex App usage without dispatching, or to register an existing worktree:

```bash
# Create worktree + register in Codex App
${CLAUDE_SKILL_DIR}/scripts/register-codex.js <repo> -b <branch> --register [--pin]

# Register an existing worktree (e.g., from a previous dispatch)
${CLAUDE_SKILL_DIR}/scripts/register-codex.js <repo> --worktree-path <path> -b <branch> -t "Title"
```

## Worktree Cleanup

Worktrees are auto-removed on successful dispatch. Use `--no-cleanup` to keep them.

To prune stale worktrees from failed/interrupted dispatches:
```bash
${CLAUDE_SKILL_DIR}/scripts/cleanup-worktrees.js              # remove worktrees > 24h old
${CLAUDE_SKILL_DIR}/scripts/cleanup-worktrees.js --all         # remove all
${CLAUDE_SKILL_DIR}/scripts/cleanup-worktrees.js --dry-run     # show what would be removed
```

## Caveats

- **Timeout**: Use `--timeout 3600`+ when self-review is included
- **App restart**: Codex App needs restart to show new worktree threads
- **Exit codes**: dispatch.js exits non-zero on failure — check before proceeding to review
- **Parallel merges**: If parallel PRs touch the same files, merge one at a time and rebase the other
