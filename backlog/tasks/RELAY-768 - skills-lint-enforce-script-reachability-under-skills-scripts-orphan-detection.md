---
id: RELAY-768
title: 'skills-lint: enforce script reachability under skills/*/scripts (orphan detection)'
status: To Do
labels:
  - documentation
  - enhancement
  - workflow
priority: medium
milestone: 
created_date: '2026-07-05'
---
## Description
## Problem

The 2026-07-05 packaging audit found ~2,400 lines of dead/misplaced scripts under packaged `skills/` (test-only helpers, archived measurement tools, tested-but-unwired helpers). The existing guard, `docs/script-inventory-and-cleanup.md`, is a manually maintained table and has already drifted: it misses ~20 scripts added since it was written (`advisory-timing.js`, `relay-routing.js`, `relay-policy*.js`, `runtime-dirt.js`, `worktree-health.js`, `executor-model-config.js`, `quality-card.js`, `task-profile.js`, `match-template.js`, `tdd-suggestion.js`, the `review-runner/*` split, …) and still lists a deleted script (`resolve-issue-number.sh`). Manual inventories don't survive this repo's PR cadence; a lint test will.

Depends on the three cleanup issues from the same audit landing first (the lint would correctly fail on today's tree).

## Scope

Add an orphan-detection test under `tests/skills-lint/` that enforces: **every `skills/*/scripts/**/*.js` file must be reachable**, where reachable means at least one of:

1. `require`d by another file under `skills/` (handle extensionless requires),
2. referenced by basename in any `skills/**/SKILL.md`, `skills/**/references/**/*.md`, `README.md`, or `CLAUDE.md`,
3. registered as an adapter script in `skills/relay-dispatch/scripts/agent-adapters/index.js` descriptors (e.g. `invoke-reviewer-*.js`, executor scripts), or
4. spawned dynamically via a `path.join(__dirname, ...)`-style literal in another skills script (e.g. `advisory-worker.js`).

Design notes:
- `cli-schema.js` registration alone must NOT count as reachable — `update-manifest-state.js` and `analyze-flip-flop-pattern.js` were registered there while dead. cli-schema is a flag registry, not a consumer.
- An explicit allowlist constant (with a required justification comment per entry) is acceptable for genuinely convention-invoked files the four rules can't see; the allowlist must start empty or near-empty and the test must fail if an allowlist entry no longer exists on disk.
- Follow existing patterns in `tests/skills-lint/` for how repo-wide lint tests are structured and run.
- In the same PR, add a "superseded by tests/skills-lint" banner note to `docs/script-inventory-and-cleanup.md` pointing at the lint test as the enforcement mechanism (keep the doc's category taxonomy and decision notes as historical rationale; do not attempt to refresh the full table).

## Acceptance Criteria

- AC1: New test file(s) under `tests/skills-lint/` pass on the post-cleanup tree via `node --test tests/skills-lint/*.test.js` (or the existing skills-lint invocation pattern).
- AC2: Mutation evidence: temporarily adding a dummy unreferenced `skills/relay-plan/scripts/zz-orphan-probe.js` makes the lint fail naming that file (demonstrated in the PR description or a test-internal fixture simulation, then removed).
- AC3: The lint recognizes all four reachability rules — adapter-registered reviewer/executor scripts and the dynamically spawned `advisory-worker.js` do not false-positive.
- AC4: `cli-schema.js`-only registration does not count as reachable (covered by a test case or fixture).
- AC5: Full test suite green across all `tests/*/scripts/*.test.js` suites plus the new skills-lint test.
- AC6: `docs/script-inventory-and-cleanup.md` carries the superseded-by banner; no other docs edited.

Part of the skills-packaging cleanup audit (2026-07-05).

