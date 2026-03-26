# dev-relay

Relay development work between Claude Code (planner/reviewer) and Codex (executor).

## Project Structure

```
skills/
  relay/                   ← Overview + reference (disable-model-invocation)
    references/prompt-template.md
  relay-plan/              ← AC → scoring rubric → dispatch prompt
    references/rubric-examples.md
  relay-dispatch/          ← Dispatch to Codex (scripts live here)
    scripts/dispatch.js
    scripts/register-worktree.js
  relay-review/            ← PR review (context: fork for fresh eyes)
    references/evaluate-criteria.md
    references/reviewer-prompt.md
  relay-merge/             ← Merge + cleanup + sprint file update
```

Multi-skill design: each phase is a separate skill for independent invocation on both Claude Code and Codex. `npx skills add sungjunlee/dev-relay` installs all 5.

## Key Design Decisions

- **PR is the handoff boundary** — Codex delivers a PR; Claude reviews, merges, handles follow-up
- **Codex does the heavy lifting** — implement + self-review + fix + PR, all in one session
- **Claude reviews with fresh eyes** — independent Agent context, no planning bias
- **Quota-aware** — maximize Codex work, minimize Claude review turns
- **Stateless** — all progress tracking lives in dev-backlog's sprint file
- **Multi-skill** — relay-dispatch, relay-review, relay-merge are independently invocable
- **Cross-platform** — works on Claude Code (skills) and Codex (agent skills)

## Working on This Project

- All content in English
- Scripts use `execFileSync` (no shell injection) — never use `execSync` with string interpolation
- Test script changes with `--dry-run` flag before real dispatch
- Codex internal paths (SQLite, global state) are fragile — document which Codex version they target
- Keep each SKILL.md under 150 lines; use references/ for details
