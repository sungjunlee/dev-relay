# Post-Phase-0 Runtime Cleanup Backlog

This document compresses the repo-audit output from the `simplify` and `plan-eng-review` passes into a small next-wave backlog. The goal is not "refactor everything." The goal is to remove non-core complexity after the current safety tail closes, without weakening relay's lifecycle guarantees.

## Shape

Keep the backlog to one prerequisite bucket plus two epics:

- Prerequisite bucket: finish the live Phase 0 tail that still affects trust roots, recovery reachability, or migration semantics.
- Epic A: runtime boundary cleanup.
- Epic B: lifecycle migration cleanup.

That is enough structure to guide execution without creating a second backlog inside the backlog.

## GitHub Registration

Registered on GitHub as:

- Epic A: `#192`
- Epic B: `#193`
- A1: `#187`
- A2: `#188`
- A3: `#189`
- B1: `#190`
- B2: `#191`

## Prerequisite Bucket (existing issues, no new epic)

Do not start structural simplification before these are settled:

- `#185` gate-check stamp-lock timeout allows merge on unstamped manifest
- `#163` rubric fail-closed recovery path is dead
- `#160` validate `paths.repo_root` / `paths.worktree` as trust roots
- `#161` symlink rubric bypass
- `#151` grandfather flag -> migration manifest + provenance

Why this bucket exists:

- `#185` / `#160` / `#161` are still on the trust-boundary path.
- `#163` is a live recovery contradiction between `review-runner` and `dispatch --run-id`.
- `#151` is the precondition for deleting grandfathering cleanly instead of smearing migration state across runtime code.

## Epic A — Runtime Boundary Cleanup (`#192`)

Outcome:
Reduce blast radius around worktree creation, manifest mutation, and review orchestration without changing the relay lifecycle contract.

### Issue A1 — Consolidate worktree lifecycle under one shared runtime (`#187`)

Why:
`skills/relay-dispatch/scripts/dispatch.js` and `skills/relay-dispatch/scripts/create-worktree.js` both own worktree creation, copy/register steps, and dry-run behavior. That duplication is a regression surface, not useful flexibility.

Scope:

- Extract a shared worktree runtime module from the two entry points.
- Keep `create-worktree.js` as a thin CLI wrapper over the shared runtime.
- Preserve existing dry-run output and Codex app registration behavior.
- Add parity coverage for `dispatch` and `create-worktree` flows.

Done when:

- One implementation owns create/copy/register semantics.
- Both entry points exercise the same runtime path.
- Regression tests prove parity for the shared lifecycle.

### Issue A2 — Split `relay-manifest` into narrower platform boundaries (`#188`)

Why:
`skills/relay-dispatch/scripts/relay-manifest.js` is the biggest blast-radius module in the repo. It mixes manifest storage, frontmatter codec, state transitions, rubric invariants, cleanup helpers, attempt history, and environment snapshots.

Scope:

- Separate manifest store/codec concerns from transition/invariant helpers.
- Pull cleanup/attempt/environment helpers behind narrower modules.
- Reduce consumer imports so callers depend on the smallest surface they need.
- Keep `validateTransition()` as the only state-transition gate.

Done when:

- Manifest I/O, lifecycle rules, and cleanup helpers are no longer coupled in one file.
- The import graph shows fewer consumers reaching for the whole manifest module.
- Behavior stays byte-for-byte compatible at the manifest contract level.

### Issue A3 — Decompose `review-runner` into staged pipeline helpers (`#189`)

Why:
`skills/relay-review/scripts/review-runner.js` currently owns rubric loading, prompt assembly, reviewer invocation, verdict validation, GitHub comment rendering, divergence analysis, and manifest application. It has too many reasons to change.

Scope:

- Extract rubric/context loading and prompt assembly helpers.
- Extract verdict parsing/validation and reviewer-comment rendering helpers.
- Isolate reviewer invocation + GitHub I/O from manifest mutation flow.
- Add module-level tests for the extracted stages.

Done when:

- The top-level runner reads as orchestration, not a god file.
- Most behavior changes land in stage helpers with focused tests.
- Review semantics and fail-closed policy stay unchanged.

## Epic B — Lifecycle Migration Cleanup (`#193`)

Outcome:
Delete transition-era complexity after the migration contract is explicit and safe.

### Issue B1 — Retire grandfathering after migration readiness closes (`#190`)

Depends on:

- `#151` grandfather flag -> migration manifest + provenance

Why:
`rubric_grandfathered` is the clearest removable non-core complexity in the repo, but deleting it before the migration story is explicit would trade code cleanup for operator confusion.

Scope:

- Inventory remaining grandfathered manifests/runs.
- Define the removal gate in terms of migration readiness, not calendar time.
- Remove grandfathering branches from dispatch/review/merge once the gate is met.
- Delete grandfathering-only tests/docs after removal.

Done when:

- No runtime branch depends on `rubric_grandfathered`.
- Migration provenance is recorded in one place instead of a boolean escape hatch.
- Operators still have a documented recovery path for pre-migration artifacts.

### Issue B2 — Move resolver history and script boilerplate out of runtime hot paths (`#191`)

Why:
The repo still carries a lot of "how we got here" inside runtime files, especially `skills/relay-dispatch/scripts/relay-resolver.js`. The fail-closed behavior is earned; the inline audit narrative and repeated CLI parsing boilerplate are not.

Scope:

- Move long resolver audit-history commentary into a tracked doc and keep only invariant comments inline.
- Extract shared CLI arg/usage helpers for thin Node entry points where it reduces duplication cleanly.
- Do not weaken resolver selection rules or rewrite the resolver contract.

Done when:

- Runtime files keep the invariants, not the full historical essay.
- Thin scripts share small CLI helpers instead of each re-implementing usage parsing.
- Behavior is unchanged; this is packaging cleanup only.

## Recommended Sequence

1. Close the prerequisite bucket: `#185 -> #163 -> #160 -> #161 -> #151`.
2. Run Epic A in this order: `A1 worktree runtime -> A2 manifest split -> A3 review-runner decomposition`.
3. Start Epic B only after `#151` is closed and Epic A has reduced the main blast radii.

## Explicitly Not In Scope

- Replacing markdown manifests with a DB or SQLite
- Weakening fail-closed resolver / review / merge behavior in the name of simplicity
- A broad dispatch rewrite with no bounded contract
- Test-count reduction as a simplification tactic

## Promotion Rule

When the team is ready to publish this backlog into GitHub:

- Create no more than two new epics from this document.
- Keep the prerequisite bucket as existing issues, not a fresh epic.
- Prefer one issue per execution boundary, not one issue per file.
