# dev-relay

**Delegate implementation to AI agents. Keep planning and review in your hands.**

dev-relay orchestrates the handoff between [Claude Code](https://claude.ai/code) (planner/reviewer) and [Codex](https://chatgpt.com/codex) (executor). You define what to build. Codex builds it in an isolated worktree. Claude reviews the PR with fresh eyes — no planning bias. The result is merged only after an auditable review trail exists.

```
Claude Code                  Codex                       GitHub
 │                            │                            │
 ├── plan + rubric ──────────►│                            │
 │                            ├── implement ──────────────►│  PR
 │                            │                            │
 ├── review (fresh context) ◄─┤                            │
 │   ├── contract checks      │                            │
 │   ├── rubric verification  │                            │
 │   ├── quality sweep        │                            │
 │   └── issues found? ──────►├── re-dispatch ───────────►│  PR updated
 │                            │                            │
 ├── LGTM ────────────────────────────────────────────────►│  merged
 └── cleanup + sprint update                               │
```

## Why

AI coding agents are powerful executors but produce better results when given clear scope and independent review. dev-relay codifies this workflow:

- **Separation of concerns** — planning and review stay with you; implementation is delegated
- **Bias-free review** — the reviewer runs in a forked context with no memory of the plan
- **Audit trail** — every merge requires a documented review verdict on the PR
- **Convergence loop** — the reviewer can re-dispatch fixes until the PR meets the rubric, not just eyeball it once

## Install

```bash
npx skills add sungjunlee/dev-relay
```

Installs all 5 skills as [Claude Code custom slash commands](https://docs.anthropic.com/en/docs/claude-code/skills). Add `-g -y` for global install without prompts:

```bash
npx skills add sungjunlee/dev-relay -g -y
```

<details>
<summary>Install from a local clone</summary>

```bash
git clone https://github.com/sungjunlee/dev-relay.git
cd dev-relay
npx skills add . -g -y
```
</details>

### Prerequisites

- [Claude Code](https://claude.ai/code) or [Codex](https://chatgpt.com/codex)
- [`gh` CLI](https://cli.github.com/) — authenticated (`gh auth login`)
- Git 2.20+
- Node.js 18+

## Quick Start

### One command — full cycle

```
/relay 42
```

Reads issue #42, builds a scoring rubric if the task is complex, dispatches to Codex in a worktree, reviews the resulting PR, and merges on LGTM.

### Step by step

Use individual skills when you want control over each phase:

```bash
/relay-plan 42          # Convert issue AC into a scoring rubric
/relay-dispatch         # Dispatch to Codex (worktree → implement → PR)
/relay-review fix/42    # Review PR in a fresh context
/relay-merge 123        # Gate-check → merge → cleanup
```

## Skills

| Command | Phase | Description |
|---------|-------|-------------|
| `/relay [issue]` | All | Full cycle — plan, dispatch, review, merge |
| `/relay-plan [issue]` | Plan | Build scoring rubric from acceptance criteria |
| `/relay-dispatch` | Execute | Dispatch to Codex via git worktree isolation |
| `/relay-review [branch]` | Review | Independent PR review with convergence loop |
| `/relay-merge [PR]` | Ship | Merge after LGTM, cleanup worktree, update sprint |

## How It Works

### Plan — `/relay-plan`

Converts acceptance criteria into a **scoring rubric** that guides both the executor and the reviewer:

| Rubric element | Example |
|---------------|---------|
| **Automated checks** | `npm test` exits 0, `tsc --noEmit` passes |
| **Evaluated factors** | Code quality 8+, naming consistency 7+, edge cases covered |
| **Weights** | Required (must pass) vs best-effort (nice to have) |

The rubric travels with the task — Codex uses it to self-evaluate, and the reviewer re-scores independently.

> **When to skip:** Typos, one-liner fixes, simple bugs. Use rubrics for 3+ acceptance criteria or quality-sensitive work.

### Dispatch — `/relay-dispatch`

Creates an isolated git worktree, writes a relay run manifest, runs the executor with the task prompt, and collects results.

```bash
# Minimal
/relay-dispatch --branch fix/login-bug --prompt "Fix the null check in auth.ts"

# With rubric and extended timeout
/relay-dispatch --branch feat/search --prompt-file rubric.md --timeout 3600

# Dry run — see the plan without executing
/relay-dispatch --branch feat/search --prompt "Add search" --dry-run
```

<details>
<summary>All dispatch options</summary>

| Flag | Description | Default |
|------|-------------|---------|
| `--branch, -b` | Branch name | *required* |
| `--prompt, -p` | Task prompt | *required (or --prompt-file)* |
| `--prompt-file` | Read prompt from file | — |
| `--executor, -e` | Executor type | `codex` |
| `--model, -m` | Model override | — |
| `--sandbox` | `workspace-write` or `read-only` | `workspace-write` |
| `--copy-env` | Copy `.env` to worktree | `false` |
| `--copy` | Additional files to copy (comma-separated) | — |
| `--timeout` | Timeout in seconds | `1800` |
| `--register` | Register in executor app, keep worktree | `false` |
| `--no-cleanup` | Compatibility alias; worktree is already retained by default | `false` |
| `--dry-run` | Print plan, don't execute | `false` |
| `--json` | Structured JSON output | `false` |

**Timeout guidance:** 1800s for simple tasks, 3600s with self-review, 5400s for complex multi-file work.

Dispatch now writes a run manifest to `.relay/runs/<run-id>.md` in the target repo. JSON output includes `runId`, `manifestPath`, `runState`, and `cleanupPolicy`. A successful first-pass dispatch should usually end in `runState: review_pending`.

Successful dispatches retain their worktree by default so review, follow-up fixes, and manual inspection can continue in the same branch context.

At the moment, manifest state is written by dispatch only. Review and merge are not yet driven by the manifest; that lifecycle refactor is tracked separately.
</details>

### Review — `/relay-review`

Runs in a **forked Agent context** — the reviewer has no memory of the planning phase, ensuring unbiased evaluation.

The review loops until convergence (most PRs: 1–3 rounds, safety cap: 20):

1. **Contract checks** — Is the implementation faithful to the AC? Any stubs or placeholders? Security issues?
2. **Rubric verification** — Re-run automated checks, re-score evaluated factors independently
3. **Quality sweep** — Structural review + code simplification pass
4. **Drift detection** — Catches scope creep or stuck iteration loops

The verdict is posted as a PR comment with a machine-readable marker:

```
Verdict: LGTM           # or
Verdict: ESCALATED      # with specific issues and file:line references
```

If issues are found, the reviewer can re-dispatch Codex with targeted fix instructions — no manual intervention needed.

### Merge — `/relay-merge`

Before merging, a **gate check** verifies the relay-review audit trail exists on the PR. No review comment → merge blocked.

After gate check passes:
1. Merge PR via GitHub API
2. Close linked issue
3. Update sprint file state (if using [dev-backlog](https://github.com/sungjunlee/dev-backlog))
4. Create follow-up issues for deferred work
5. Cleanup retained worktree and remote branch

<details>
<summary>Sprint file state transitions</summary>

```
[ ] Task                           ← not started
[~] Task → PR #M (reviewing)      ← in progress
[x] Task → PR #M (merged)         ← done
```
</details>

<details>
<summary>Gate check escape hatch</summary>

For hotfixes or emergencies, skip the review gate with a documented reason:

```bash
# Writes an audit comment on the PR explaining why review was skipped
gate-check.js 42 --skip "hotfix: production down"
```

The skip is recorded on the PR — there's always a paper trail.
</details>

## `.worktreeinclude`

Git worktrees don't include gitignored files (`.env`, config, keys). Add a `.worktreeinclude` file to your project root to auto-copy them into worktrees:

```
# .worktreeinclude — one pattern per line
.env
.env.local
config/*.key
```

**Safety:** Only files matching BOTH `.worktreeinclude` AND `.gitignore` are copied. This prevents accidentally including tracked files. Glob patterns are supported. Missing files are silently skipped.

The `--copy-env` and `--copy` dispatch flags work as explicit overrides for one-off cases.

## Works With dev-backlog

dev-relay works standalone — it reads acceptance criteria from GitHub issues or direct input.

For sprint-level orchestration, pair it with [dev-backlog](https://github.com/sungjunlee/dev-backlog):

- **GitHub Issues** define the work (AC, labels, milestones)
- **Sprint files** organize execution (batching, ordering, context, progress)
- **relay** reads from both, updates sprint files at each phase

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| PR as handoff boundary | Clean separation between execution and review; standard GitHub workflow |
| Fresh-context review | Prevents confirmation bias — the reviewer evaluates the diff, not the plan |
| Rubric-based scoring | Codex self-evaluates during execution; reviewer re-scores independently |
| Gate check before merge | Every merge has an audit trail; no silent approvals |
| Worktree isolation | Executor can't affect your working directory; parallel dispatches are safe |
| Stateless by default | No database, no daemon — state lives in GitHub and optional sprint files |

## Contributing

Issues and PRs welcome. Please open an issue first for non-trivial changes.

## License

MIT
