# dev-relay

Relay development work between Claude Code (planner/reviewer) and Codex (executor).

## Install

```bash
npx skills add sungjunlee/dev-relay
```

This installs all 5 skills globally. Use `-g` for global, `-y` to skip prompts:

```bash
npx skills add sungjunlee/dev-relay -g -y
```

To install from a local clone:

```bash
npx skills add . -g -y
```

## Skills

| Skill | Command | Purpose |
|-------|---------|---------|
| **relay** | `/relay [issue]` | Full cycle: plan, dispatch, review, merge |
| **relay-plan** | `/relay-plan [issue]` | Build scoring rubric from acceptance criteria |
| **relay-dispatch** | `/relay-dispatch` | Dispatch to Codex via worktree isolation |
| **relay-review** | `/relay-review [branch]` | Independent PR review with convergence loop |
| **relay-merge** | `/relay-merge [PR]` | Merge after LGTM, update sprint file |

## How It Works

```
/relay 42
  Step 1:   Read sprint file + task AC
  Step 1.5: Resume if already in-flight ([~] state)
  Step 2:   Build rubric (relay-plan) or use base template
  Step 3:   Dispatch to Codex → Codex iterates until self-LGTM → PR created
  Step 4:   relay-review (fresh context) loops until convergence:
            contract checks → rubric verification → /review → /simplify → drift check
  Step 5:   Verify PR comment (Verdict: LGTM or ESCALATED)
  Step 6:   Merge, close issue, update sprint file
```

## `.worktreeinclude`

When dispatch creates a worktree, gitignored files (`.env`, config files, etc.) don't exist there. Add a `.worktreeinclude` file to your project root to auto-copy them:

```
# .worktreeinclude
.env
.env.local
dart-defines.json
config/*.key
```

**Rules:**
- Only files matching BOTH `.worktreeinclude` AND `.gitignore` are copied (safety)
- Glob patterns supported (`*.key`, `.env*`)
- Directories are copied recursively
- Missing files are silently skipped
- `--copy-env` and `--copy` flags still work as explicit overrides

This follows the same convention as Claude Code Desktop, Cline, and Roo Code.

## Requirements

- Claude Code or Codex
- `gh` CLI (authenticated)
- `git`
- Node.js 18+
