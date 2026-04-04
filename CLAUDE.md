# dev-relay

Relay development work across agent boundaries — plan, dispatch, review, merge.
Default combination: Claude Code orchestrates, Codex executes, Claude reviews.

## Project Structure

```
skills/
  relay/                   ← Overview + reference (disable-model-invocation)
    references/prompt-template.md
  relay-plan/              ← AC → scoring rubric → dispatch prompt
    references/rubric-examples.md
  relay-dispatch/          ← Dispatch to executor (scripts live here)
    scripts/dispatch.js
    scripts/register-codex.js
  relay-review/            ← PR review (context: fork for fresh eyes)
    references/evaluate-criteria.md
    references/reviewer-prompt.md
  relay-merge/             ← Merge + cleanup + sprint file update
```

Multi-skill design: each phase is a separate skill for independent invocation on both Claude Code and Codex. `npx skills add sungjunlee/dev-relay` installs all 5.

## Key Design Decisions

- **PR is the handoff boundary** — the executor delivers a PR; the reviewer merges and handles follow-up
- **Executor does the heavy lifting** — implement + self-review + fix + PR, all in one session
- **Reviewer operates in isolated context** — fresh eyes, no planning bias
- **Quota-aware** — maximize executor work, minimize reviewer turns
- **Stateless** — progress tracking lives in dev-backlog's sprint file when available; works without it
- **Multi-skill** — relay-dispatch, relay-review, relay-merge are independently invocable
- **Cross-platform** — works on Claude Code (skills) and Codex (agent skills)

## Working on This Project

- All content in English
- Scripts use `execFileSync` (no shell injection) — never use `execSync` with string interpolation
- Test script changes with `--dry-run` flag before real dispatch
- Executor-specific internal paths (e.g., Codex SQLite, global state) are fragile — document which version they target
- Keep each SKILL.md under 150 lines; use references/ for details
