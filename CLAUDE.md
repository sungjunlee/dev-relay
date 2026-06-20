# dev-relay

Orchestrator-agnostic relay system for plan → dispatch → review workflows with explicit merge. Any supported agent can serve as orchestrator, worker, or reviewer — roles are bound per-run via the relay manifest, not hardcoded.

## Architecture

Relay runs are stateful, manifest-backed lifecycle contracts stored in `~/.relay/runs/<repo-slug>/<run-id>.md`. Each manifest records immutable role bindings (`roles.orchestrator`, `roles.executor`, `roles.reviewer`), policy fields, and review anchors. Review-time overrides are tracked separately under `review.last_reviewer` and review events rather than mutating those bindings. The state machine governs all transitions:

```
draft → dispatched → review_pending → ready_to_merge → merged
                   ↘ escalated → closed     ↗
                     changes_requested ──→ dispatched (re-dispatch)
```

See [references/architecture.md](references/architecture.md) for the full manifest schema, state transitions, event journal format, and adapter extension points.

Before a run exists, relay-ready may persist standalone request artifacts under `~/.relay/requests/<repo-slug>/`. `/relay` bypasses that preflight step only for already relay-ready issue/task inputs with a trustworthy review anchor; otherwise it invokes relay-ready and then continues with `relay-plan -> relay-dispatch -> relay-review`, stopping at `ready_to_merge` unless the user explicitly invokes `relay-merge`.

## Project Structure

```
skills/
  relay/                   ← Full-cycle orchestration (plan → dispatch → review → stop)
    references/prompt-template.md
  relay-ready/            ← Readiness gate + relay-ready handoff persistence
    scripts/
      relay-request.js       ← Request artifact CRUD + request events
      persist-request.js     ← Single-leaf persistence entry point
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
      review-lineage.md
      runner-notes.md
      reviewer-prompt.md
  relay-merge/             ← Merge + cleanup + sprint file update
    scripts/
      gate-check.js        ← Pre-merge audit trail enforcement
      finalize-run.js      ← Merge PR, cleanup worktree, close manifest
      review-gate.js       ← Review state validation
tests/
  relay-*/                 ← Test suites and fixtures kept outside skills so installs stay runtime-only
    scripts/
    fixtures/
```

Multi-skill design: each phase is independently invocable. `npx skills add sungjunlee/dev-relay` installs all 6 skills: `relay`, `relay-ready`, `relay-plan`, `relay-dispatch`, `relay-review`, `relay-merge`.
Cross-skill install dependencies are documented in [references/install-graph.md](references/install-graph.md).

## Common Commands

```bash
# Run tests (Node.js built-in test runner, no install needed)
node --test tests/relay-ready/scripts/*.test.js
node --test tests/relay-plan/scripts/*.test.js
node --test tests/relay-dispatch/scripts/*.test.js
node --test tests/relay-review/scripts/*.test.js
node --test tests/relay-merge/scripts/*.test.js

# Probe executor environment (before rubric design)
node skills/relay-plan/scripts/probe-executor-env.js . --executor codex --json
node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json

# Dispatch dry-run (validate without executing)
node skills/relay-dispatch/scripts/dispatch.js . -b test-branch -p "task" --dry-run

# Dispatch with rubric (persists rubric for reviewer)
node skills/relay-dispatch/scripts/dispatch.js . -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml

# Worktree cleanup
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --dry-run

# Reliability report
node skills/relay-dispatch/scripts/reliability-report.js --repo . --json
node skills/relay-dispatch/scripts/reliability-report.js --repo . --by-role --json
node skills/relay-dispatch/scripts/reliability-report.js --repo . --by-dispatch --json

# Review (cross-skill: review-runner lives under relay-review, not relay-dispatch)
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --reviewer codex --json

# Recovery (when codex finishes but does not commit/push/PR)
node skills/relay-dispatch/scripts/recover-commit.js --run-id <id> --reason "..."
node skills/relay-dispatch/scripts/rebrand-evidence.js --run-id <id> --reason "..."

# Finalize / merge (cross-skill: finalize-run lives under relay-merge, not relay-dispatch)
node skills/relay-merge/scripts/finalize-run.js --run-id <id> --merge-method squash --json
node skills/relay-merge/scripts/finalize-run.js --run-id <id> --force-finalize-nonready --reason "..." --json
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
- Operator utilities and recovery playbooks live in `skills/<skill>/references/`, not SKILL.md. Sunset deprecated flags within one release.
- Test files and test fixtures live under `tests/<skill>/`, never under `skills/<skill>/`, so `npx skills add` does not install them.
- Manifest state transitions must go through `validateTransition()` — direct state assignment is a bug
- New executors: drop a file in `skills/relay-dispatch/scripts/executors/` exporting the 7-field adapter contract, register the descriptor in `agent-adapters/index.js`, and update docs/tests. See `skills/relay-dispatch/references/agent-adapter-platform.md` and `skills/relay-dispatch/scripts/executors/README.md`.
- New reviewers: create `invoke-reviewer-<name>.js` in `relay-review/scripts/` only for phases the adapter descriptor supports.

### SKILL.md frontmatter schema

Every `skills/<skill>/SKILL.md` frontmatter must start with the same required shape:

| Key | Requirement |
| --- | --- |
| `name` | Kebab-case skill identifier matching the directory name. |
| `description` | Single-line trigger description for the skill router. |
| `compatibility` | Single-line string stating runtime requirements, such as `Requires gh CLI, git, Node.js 18+.` |
| `metadata.related-skills` | Comma-separated string of sibling skill names. |

Standard optional keys:

| Key | Requirement |
| --- | --- |
| `argument-hint` | Prefer natural-language forms such as `[issue-number]` or `[run-id or PR-number]`. `relay-dispatch` intentionally keeps its CLI-spec form because it documents mutually exclusive dispatch modes. |
| `metadata.keywords` | Comma-separated trigger keywords. Operator-facing skills should include tight bilingual Korean and English tokens. |
| `context` | Only for skills that need fresh-context isolation; currently `relay-review` uses `context: fork`. |
