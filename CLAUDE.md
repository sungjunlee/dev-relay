# dev-relay

Relay development work between Claude Code (planner/reviewer) and Codex (executor).

## Project Structure

```
skills/
  dev-relay/
    SKILL.md               ← Core process (~400 lines)
    references/            ← Review criteria (on-demand)
    scripts/               ← dispatch.js, register-worktree.js
```

## Key Design Decisions

- **PR is the handoff boundary** — Codex delivers a PR; Claude reviews, merges, handles follow-up
- **Codex does the heavy lifting** — implement + self-review + fix + PR, all in one session
- **Claude reviews with fresh eyes** — independent Agent context, no planning bias
- **Quota-aware** — maximize Codex work, minimize Claude review turns
- **Stateless** — all progress tracking lives in dev-backlog's sprint file
- **Related skill**: dev-backlog (sprint planning and execution tracking)

## Two-Layer Architecture

```
Claude Code (brain)  →  dispatch.js  →  Codex (hands)
  Plan + Contract        worktree        Implement + self-review + PR
  PR Review              cleanup         ← PR as handoff
  Merge + follow-up
```

## Working on This Project

- All content in English
- Scripts use `execFileSync` (no shell injection) — never use `execSync` with string interpolation
- Test script changes with `--dry-run` flag before real dispatch
- Codex internal paths (SQLite, global state) are fragile — document which Codex version they target
