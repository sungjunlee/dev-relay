# dev-relay

Orchestrator-agnostic relay system for plan → dispatch → review → merge workflows. Any supported agent can serve as orchestrator, worker, or reviewer — roles are bound per-run via the relay manifest, not hardcoded.

## Architecture

Relay runs are stateful, manifest-backed lifecycle contracts stored in `~/.relay/runs/<repo-slug>/<run-id>.md`. Each manifest records immutable role bindings (`roles.orchestrator`, `roles.executor`, `roles.reviewer`), policy fields, and review anchors. The state machine governs all transitions:

```
draft → dispatched → review_pending → ready_to_merge → merged
                   ↘ escalated → closed     ↗
                     changes_requested ──→ dispatched (re-dispatch)
```

See [references/architecture.md](references/architecture.md) for the full manifest schema, state transitions, event journal format, and adapter extension points.

## Project Structure

```
skills/
  relay/                   ← Full-cycle orchestration (plan → dispatch → review → stop)
    references/prompt-template.md
  relay-plan/              ← AC → scoring rubric → dispatch prompt
    scripts/
      probe-executor-env.js  ← Executor environment probe (agent + project tools)
    references/rubric-*.md
  relay-dispatch/          ← Worktree isolation + executor dispatch
    scripts/
      dispatch.js          ← Core dispatch (executor-agnostic entry point)
      relay-manifest.js    ← Manifest CRUD, state machine, transitions, cleanup ops, environment snapshot
      relay-events.js      ← Event journal (~/.relay/runs/<slug>/<id>/events.jsonl)
      relay-resolver.js    ← Run-ID / manifest / branch resolution
      codex-app-register.js ← Codex App thread registration (shared module)
      create-worktree.js   ← Standalone worktree creation + optional app registration
      cleanup-worktrees.js ← Stale worktree pruning
      close-run.js         ← Force-close non-terminal runs
      reliability-report.js ← Aggregate run metrics
  relay-review/            ← Independent review (context: fork for fresh eyes)
    scripts/
      review-runner.js       ← Round management, PR comments, manifest updates
      invoke-reviewer-codex.js  ← Codex reviewer adapter
      invoke-reviewer-claude.js ← Claude reviewer adapter
    references/
      evaluate-criteria.md
      reviewer-prompt.md
  relay-merge/             ← Merge + cleanup + sprint file update
    scripts/
      gate-check.js        ← Pre-merge audit trail enforcement
      finalize-run.js      ← Merge PR, cleanup worktree, close manifest
      review-gate.js       ← Review state validation
```

Multi-skill design: each phase is independently invocable. `npx skills add sungjunlee/dev-relay` installs all 5.

## Common Commands

```bash
# Run tests (Node.js built-in test runner, no install needed)
node --test skills/relay-plan/scripts/*.test.js
node --test skills/relay-dispatch/scripts/*.test.js
node --test skills/relay-review/scripts/*.test.js
node --test skills/relay-merge/scripts/*.test.js

# Probe executor environment (before rubric design)
node skills/relay-plan/scripts/probe-executor-env.js . --executor codex --json
node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json

# Dispatch dry-run (validate without executing)
node skills/relay-dispatch/scripts/dispatch.js . -b test-branch -p "task" --dry-run

# Worktree cleanup
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --dry-run

# Reliability report
node skills/relay-dispatch/scripts/reliability-report.js --repo . --json
```

## Key Design Decisions

- **PR is the handoff boundary** — worker delivers a PR; reviewer evaluates, orchestrator merges
- **Manifest is the contract** — roles, state, policy, and review anchors live in `~/.relay/runs/`, not in transient prompts
- **Reviewer isolation** — reviews run in a fresh context (no planning bias), anchored to immutable Done Criteria
- **Quota-aware** — maximize worker turns, minimize orchestrator review turns
- **Stateless orchestration** — progress tracking integrates with dev-backlog sprint files when available; works without them
- **Extensible adapters** — new executors and reviewers are added by convention, not framework (see [references/architecture.md § Extending](references/architecture.md#extending))

## Working on This Project

- All content in English
- Scripts use `execFileSync` (no shell injection) — never use `execSync` with string interpolation
- Test script changes with `--dry-run` flag before real dispatch
- Executor-specific internal paths (e.g., Codex SQLite, global state) are fragile — document which version they target
- Keep each SKILL.md under 150 lines; use `references/` for details
- Manifest state transitions must go through `validateTransition()` — direct state assignment is a bug
- New executors: add entry to `EXECUTOR_CLI` + execution branch in `dispatch.js`; app registration uses `create-worktree.js --register`
- New reviewers: create `invoke-reviewer-<name>.js` in `relay-review/scripts/`
