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
- A persisted relay-ready handoff used by dispatch is frozen into the run-local Done Criteria; `run.json` anchors its exact path and digest under `contract.*`.

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

**Goal:** A shaped task becomes a frozen Outcome Contract in Done Criteria, a Verification plan, an optional Earned Rubric, and a dispatch prompt that executor and reviewer can both use without relying on planner memory.

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
- Every plan defines the mandatory Outcome Contract and Verification channels: Done Criteria freeze required results and explicit non-goals, while executable checks and observable evidence verify them without changing their scope.
- Earned Rubric is optional and may have zero factors. Factors are derived only after observing a meaningful quality gradient among contract-satisfying results, and only the independent reviewer scores them.

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

**Goal:** A planned task runs in worktree isolation with a chosen executor, while immutable run identity and append-only attempt facts preserve the evidence needed for recovery and review.

**In-scope:**
- `skills/relay-dispatch/` worktree creation, immutable `run.json` creation, executor invocation, and attempt artifact publication.
- `skills/relay-fleet/` immutable cohort fan-out and derived child-run status.
- Executor adapters under `skills/relay-dispatch/scripts/adapters/`.

**Out-of-scope:**
- Authoring rubrics or prompts, which belongs to `planning`.
- Reviewing the PR, which belongs to `review-cycle`.
- Merging or cleanup finalization, which belongs to `merge-finalize`.

### Expected Behaviors
- A new dispatch records repository, branch, retained worktree, frozen Done Criteria digest, and immutable role bindings in `run.json` before it starts the executor attempt.
- Attempt start and completion evidence is appended to `events.jsonl`; dispatch does not encode a mutable lifecycle state.
- Executor-specific code is isolated behind the executor adapter contract instead of branching throughout `dispatch.js`.
- A fleet stores one immutable cohort, and each child run may carry an immutable `parent` pointer so status can be derived again after interruption.

### Hard Constraints
- Never write executor output directly into the user's active repo checkout; dispatch work happens in retained relay worktrees.
- Never commit, push, publish a PR, invoke recovery, or rewrite `run.json` from dispatch.
- Never append facts except through `facts.appendFact`.

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
- 2026-07-19 (run #issue-1018-20260715140642631-1dcc40c5): relay-merge of PR #1023 [PR #1023]
- 2026-07-19 (run #issue-1016-20260715142738643-a408b02d): relay-merge of PR #1024 [PR #1024]
- 2026-07-20 (run #issue-1037-20260720143139054-fbc0c2a0): relay-merge of PR #1044 [PR #1044]
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: review-cycle

**Goal:** A PR is scored in a fresh context against frozen Done Criteria and rubric anchors, and the merge gate is tied to the exact commit SHA that was reviewed.

**In-scope:**
- `skills/relay-review/` review runner, immutable review-bundle construction, reviewer invocation, and verdict fact append.
- Fresh-context review using `context: fork` semantics from the skill contract.

**Out-of-scope:**
- Writing implementation code, which remains the executor's job.
- Mutating review anchors after dispatch.
- Merging the PR, which belongs to `merge-finalize`.

### Expected Behaviors
- The reviewer loads file-backed Done Criteria from `run.contract.done_criteria_path` and verifies the immutable digest before use.
- A passing review appends one `review_recorded` fact bound to the exact PR head and Done Criteria digest; merge-time inspection rejects a later HEAD advance as stale.
- `changes_requested` derives `redispatch`; the next executor attempt preserves the same immutable run identity and frozen Done Criteria.

### Hard Constraints
- Never invoke the reviewer with planner session memory; review must run in a fresh process/context anchored to persisted artifacts.
- Never post comments, mutate the worktree, or record a review from a stale PR head, missing verification, or changed derived action.

### Learnings
<!-- LEARN:BEGIN -->
- 2026-07-20 (run #issue-1040-20260720141108206-a0041804): relay-merge of PR #1045 [PR #1045]
- 2026-07-20 (run #issue-1036-20260720165108485-5e65cf49): relay-merge of PR #1048 [PR #1048]
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: merge-finalize

**Goal:** A reviewed PR lands, one `merge_recorded` fact makes the derived run terminal, cleanup is attempted, and any matching capability learning is written durably or surfaced as an explicit manual action.

**In-scope:**
- `skills/relay-merge/` read-only gate-check, exact-SHA PR merge, `merge_recorded` fact append, and branch/worktree cleanup.
- `skills/relay-merge/scripts/append-learnings.js` marker-bounded updates to `<repo>/spec/capabilities.md`.
- Cleanup status and learning result reporting in `finalize-run.js` JSON output.

**Out-of-scope:**
- Deciding whether the implementation is correct; that belongs to `review-cycle`.
- Authoring `spec/capabilities.md` contracts; that belongs to `backlog-charter grill`.
- Rewriting sprint files outside the existing merge/progress conventions.

### Expected Behaviors
- `finalize-run.js` appends `merge_recorded` only after GitHub reports the exact reviewed PR head as `MERGED`; otherwise it leaves the run safe to retry.
- Learning append first resolves exactly one active sprint and one kebab-case capability target; ambiguity fails loud before writing.
- A successful learning append is committed and pushed from the target repo's base branch when safe; if not safe, the result reports a manual action instead of pretending durability happened.

### Hard Constraints
- Never merge a PR whose latest passing `review_recorded.reviewed_sha` does not match current PR HEAD; there is no review bypass.
- Never write outside the matching capability's LEARN BEGIN/END comment markers.

### Learnings
<!-- LEARN:BEGIN -->
- 2026-07-20 (run #issue-955-20260720171527060-5631994b): relay-merge of PR #1051 [PR #1051]
- 2026-07-20 (run #issue-956-20260720204955497-a9eab5cc): relay-merge of PR #1052 [PR #1052]
- 2026-07-21 (run #issue-957-20260720214029585-15fe71ce): relay-merge of PR #1055 [PR #1055]
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: run-lifecycle

**Goal:** Every Relay run remains auditable and recoverable from immutable `run.json`, frozen Done Criteria, append-only facts, and fresh external observations without a mutable lifecycle state.

**In-scope:**
- `skills/relay-dispatch/scripts/run-store.js` immutable run and artifact trust boundary.
- `skills/relay-dispatch/scripts/facts.js` append-only `events.jsonl` validation and merge authorization.
- `skills/relay-dispatch/scripts/inspect.js` pure fact fold into one typed derived action.
- `skills/relay-dispatch/scripts/recover.js` production observation and the sole general recovery/close writer.
- `skills/relay-dispatch/scripts/host.js` per-run lock capability and host audit facts.

**Out-of-scope:**
- The specific implementation work done by executors in retained worktrees.
- Human sprint planning choices outside the Relay run.
- Independent review scoring and explicit merge authorization, which belong to `review-cycle` and `merge-finalize`.

### Expected Behaviors
- Run creation claims a run directory once and writes one validated version-3 `run.json`; identity, role bindings, branch/worktree, and Done Criteria anchor never change afterward.
- Facts validate before append and `inspect` derives one action from their durable order plus fresh Git, GitHub, host, and verification observations.
- Every lifecycle write re-inspects under the run lock and requires the same action key; `recover` is the only general writer that may converge attempts, publication, verification, or close.
- `merge_recorded` and `run_closed` facts derive terminal outcomes that later active facts cannot reopen.
- Regular-file and containment checks reject run identity, Done Criteria, facts, and artifact paths that escape their trusted boundaries.

### Hard Constraints
- Never rewrite `run.json` or `events.jsonl`; append durable facts only through `facts.appendFact`.
- Never introduce mutable manifests, transition tables, execution-evidence sidecars, or a second recovery path.
- Never write from a stale inspection or bypass `host.withRunLock` for a lifecycle mutation.

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |
