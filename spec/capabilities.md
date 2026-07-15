# dev-relay Capabilities

This file is the middle layer between the project-level direction and the active sprint. dev-relay has not opted into a repo-root `CHARTER.md` yet, so this document is intentionally scoped to implemented relay behavior and current extension points.

**Status:** Initial dev-relay capability draft for spec-system dogfood. Each Behavior and Hard Constraint below is written against implemented files, tests, or documented runtime contracts. Aspirational behavior belongs in GitHub issues, not in this reference axis.

Mutation discipline follows the spec-system contract from `sungjunlee/dev-backlog`: Goal/Scope/Behaviors/HardConstraints are human-gated through `backlog-charter grill`; `## Learnings` is written only by `skills/relay-merge/scripts/append-learnings.js` between markers; `## Decisions` is append-only by convention.

| Section | Who writes | When | Gate |
|---|---|---|---|
| `Goal`, `In-scope`, `Out-of-scope` | human via `backlog-charter grill` | when the contract changes | challenge + confirm + apply |
| `Expected Behaviors`, `Hard Constraints` | human via grill | when behavior or a bright-line changes | grill + 3-axis predicate test |
| `## Learnings` | `append-learnings.js` only | after a successful relay merge for this capability | marker-bounded append, then durable commit/push or explicit manual action |
| `## Decisions` | human, append-only | when a capability-level decision is made | append-only by convention |

---

## Capability: readiness-shaping

**Goal:** Ambiguous work becomes a stable relay-ready request artifact and frozen Done Criteria before planning starts.

**In-scope:**
- `skills/relay-ready/` request scoring, bounded Q&A, and request persistence.
- Request artifacts under `~/.relay/requests/<repo-slug>/`.
- Dispatch linkage through `source.request_id`, `source.leaf_id`, and `anchor.done_criteria_path`.

**Out-of-scope:**
- Rubric authoring, which belongs to `planning`.
- Executor selection or worktree creation, which belongs to `dispatch-execution`.

### Expected Behaviors
- When `/relay` cannot safely bypass readiness and prompts are allowed, it asks exactly one bounded readiness question using the probe's `signals_summary`; it does not silently proceed.
- A non-interactive readiness failure emits `readiness_check_failed_nontty` and stops instead of falling through to planning.
- A persisted relay-ready handoff used by dispatch is represented in the run manifest as `source.request_id`, `source.leaf_id`, and `anchor.done_criteria_path`.

### Hard Constraints
- Never bypass readiness without an explicit skip reason from the operator or a pre-existing trusted handoff.
- Never mutate a frozen Done Criteria artifact for the same request leaf after dispatch has anchored to it.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: planning

**Goal:** A shaped task becomes frozen Done Criteria, a scored rubric, and a dispatch prompt that executor and reviewer can both use without relying on planner memory.

**In-scope:**
- `skills/relay-plan/` Done Criteria recovery, ambiguity audit, rubric authoring, and dispatch prompt handoff.
- Planner-authored Done Criteria persisted to `~/.relay/runs/<repo-slug>/<run-id>/done-criteria.md`.
- `/tmp/dispatch-<N>.md`, `/tmp/rubric-<N>.yaml`, and optional `/tmp/done-criteria-<N>.md` handoff artifacts.

**Out-of-scope:**
- Invoking the executor, which belongs to `dispatch-execution`.
- Scoring the actual diff, which belongs to `review-cycle`.
- Shaping raw ambiguous requests before planning, which belongs to `readiness-shaping`.

### Expected Behaviors
- When planning changes or authors Done Criteria, the same `RUN_ID` is used for persistence and for the downstream `relay-dispatch --run-id` handoff.
- A dispatch handoff with planner-authored Done Criteria includes `--done-criteria-file <path>` so downstream review uses the frozen file, not re-derived issue prose.
- Every non-trivial rubric has at least one required factor, concrete criteria, and at least one prerequisite command target that can be run by the executor.

### Hard Constraints
- Never call `relay-dispatch` from `relay-plan`; planning produces handoff artifacts only.
- Never treat explicit issue Acceptance Criteria as the only evidence when repo risk, ambiguity, or relay-ready handoff data implies additional observable Done Criteria.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: dispatch-execution

**Goal:** A planned task runs in worktree isolation with a chosen executor, and the manifest records the branch, worktree, PR handoff data, and execution evidence needed for review.

**In-scope:**
- `skills/relay-dispatch/` worktree creation, executor invocation, manifest creation/update, recovery utilities, and execution evidence.
- `skills/relay-fleet/` parent/child fan-out dispatch and crashed-fleet resume.
- Executor adapters under `skills/relay-dispatch/scripts/executors/`.

**Out-of-scope:**
- Authoring rubrics or prompts, which belongs to `planning`.
- Reviewing the PR, which belongs to `review-cycle`.
- Merging or cleanup finalization, which belongs to `merge-finalize`.

### Expected Behaviors
- A dispatch that advances to `review_pending` has a retained worktree path and branch metadata recorded in the manifest.
- Executor-specific code is isolated behind the executor adapter contract instead of branching throughout `dispatch.js`.
- Fleet parent and child manifests reference each other so status can be recovered from either side after interruption.

### Hard Constraints
- Never write executor output directly into the user's active repo checkout; dispatch work happens in retained relay worktrees.
- Never mutate manifest state by direct assignment; transitions go through the lifecycle validation helpers.

### Learnings
<!-- LEARN:BEGIN -->
- 2026-07-05 (run #issue-767-20260704235320527-cdfac42e): relay-merge of PR #780 [PR #780]
- 2026-07-05 (run #issue-788-20260705072111604-84a15ef5): relay-merge of PR #790 [PR #790]
- 2026-07-05 (run #issue-794-20260705113330215-c4fff992): relay-merge of PR #798 [PR #798]
- 2026-07-05 (run #issue-793-20260705113325650-8648a194): relay-merge of PR #796 [PR #796]
- 2026-07-05 (run #issue-785-20260705113322470-cd3b1a26): relay-merge of PR #797 [PR #797]
- 2026-07-05 (run #issue-784-20260705064553928-c4ed5772): relay-merge of PR #791 [PR #791]
- 2026-07-05 (run #issue-781-20260705064555918-aefaea7c): relay-merge of PR #792 [PR #792]
- 2026-07-06 (run #issue-800-20260705234805031-4092e1ce): relay-merge of PR #803 [PR #803]
- 2026-07-06 (run #issue-805-20260706100610644-658ece28): relay-merge of PR #810 [PR #810]
- 2026-07-06 (run #issue-781-20260706100610645-b0d2faf2): relay-merge of PR #811 [PR #811]
- 2026-07-06 (run #issue-801-20260706094550181-a0ba62cd): relay-merge of PR #812 [PR #812]
- 2026-07-07 (run #issue-802-20260706213840231-398c923d): relay-merge of PR #817 [PR #817]
- 2026-07-07 (run #issue-807-20260706132255933-585f0a8b): relay-merge of PR #814 [PR #814]
- 2026-07-07 (run #issue-782-20260706132255658-ad6ee5d0): relay-merge of PR #813 [PR #813]
- 2026-07-15 (run #issue-1020-20260715103914654-089eee0b): relay-merge of PR #1022 [PR #1022]
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: review-cycle

**Goal:** A PR is scored in a fresh context against frozen Done Criteria and rubric anchors, and the merge gate is tied to the exact commit SHA that was reviewed.

**In-scope:**
- `skills/relay-review/` review runner, reviewer adapters, prompt construction, PR comments, re-dispatch prompts, and verdict application.
- Fresh-context review using `context: fork` semantics from the skill contract.
- Advisory review reports that do not gate merge.

**Out-of-scope:**
- Writing implementation code, which remains the executor's job.
- Mutating review anchors after dispatch.
- Merging the PR, which belongs to `merge-finalize`.

### Expected Behaviors
- The reviewer loads file-backed Done Criteria from `anchor.done_criteria_path` before GitHub issue or PR body fallbacks.
- A passing review records `review.last_reviewed_sha`; merge-time gate checks reject a later HEAD advance as stale.
- `CHANGES_REQUESTED` produces a targeted re-dispatch prompt that preserves the original Done Criteria and carries prior review feedback forward.

### Hard Constraints
- Never invoke the reviewer with planner session memory; review must run in a fresh process/context anchored to persisted artifacts.
- Never let advisory review output change the merge-gating verdict field.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: merge-finalize

**Goal:** A reviewed PR lands, the manifest reaches `merged`, cleanup is attempted, and any matching capability learning is written durably or surfaced as an explicit manual action.

**In-scope:**
- `skills/relay-merge/` gate-check, review gate validation, PR merge, issue close, branch/worktree cleanup, and learning append.
- `skills/relay-merge/scripts/append-learnings.js` marker-bounded updates to `<repo>/spec/capabilities.md`.
- Cleanup status and learning result reporting in `finalize-run.js` JSON output.

**Out-of-scope:**
- Deciding whether the implementation is correct; that belongs to `review-cycle`.
- Authoring `spec/capabilities.md` contracts; that belongs to `backlog-charter grill`.
- Rewriting sprint files outside the existing merge/progress conventions.

### Expected Behaviors
- `finalize-run.js` advances to `merged` only after GitHub reports the PR as `MERGED`; otherwise it leaves the run safe to retry.
- Learning append first resolves exactly one active sprint and one kebab-case capability target; ambiguity fails loud before writing.
- A successful learning append is committed and pushed from the target repo's base branch when safe; if not safe, the result reports a manual action instead of pretending durability happened.

### Hard Constraints
- Never merge a PR whose `review.last_reviewed_sha` does not match current PR HEAD unless an explicit audited review bypass is used.
- Never write outside the matching capability's LEARN BEGIN/END comment markers.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: manifest-lifecycle

**Goal:** Every relay run is auditable from its manifest and event journal: role bindings, state transitions, policy decisions, anchors, and cleanup state stay observable after interruption.

**In-scope:**
- `~/.relay/runs/<repo-slug>/<run-id>.md` manifest schema and run directory layout.
- State transitions and validation helpers in `skills/relay-dispatch/scripts/manifest/`.
- Event journal entries under the run directory.

**Out-of-scope:**
- The specific implementation work done by executors in retained worktrees.
- Human sprint planning choices outside the relay manifest.

### Expected Behaviors
- Role bindings under `roles.*` are immutable once assigned; acting reviewer overrides are recorded separately under review fields and events.
- Terminal states such as `merged` and `closed` are not reopened into active workflow states.
- Path trust checks reject manifest repo roots and worktree paths that escape the expected relay directories.

### Hard Constraints
- Never mutate `roles.{orchestrator,executor,reviewer}` as a shortcut for per-round acting-role metadata.
- Never bypass `validateTransition()` or lifecycle helper enforcement when changing `manifest.state`.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |
