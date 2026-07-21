# Relay Architecture Reference

Deep-dive into the manifest contract, state machine, and extension points. For overview, see [CLAUDE.md](../CLAUDE.md).

This reference centers on the manifest-backed run lifecycle, plus the readiness boundary that may sit ahead of `relay-plan`. For the full relay-ready control-flow contract, see [docs/relay-ready-routing-and-handoff-design.md](../docs/relay-ready-routing-and-handoff-design.md). For provider/model route policy setup and operator examples, see [docs/model-route-policy.md](../docs/model-route-policy.md). For the public/internal/optional skill tiers, see [operator-surface.md](operator-surface.md).

## Readiness Boundary

Before a run manifest exists, raw work may live in relay-ready artifacts under `~/.relay/requests/<repo-slug>/`.

```text
raw request
  -> relay-ready request artifact + events
  -> relay-ready handoff brief(s) + frozen Done Criteria snapshot(s)
  -> relay-plan
  -> relay-dispatch run manifest
  -> relay-review (internal, before PR publication)
  -> publish PR
  -> post-publication relay-review
  -> ready_to_merge
  -> relay-merge (explicit only)
```

Boundary rules:

- `/relay` remains the public front door for full-cycle execution
- `/relay` bypasses relay-ready only for issue-first or task-first inputs that are already relay-sized and already have a trustworthy review anchor
- `/relay` invokes relay-ready for ambiguous, oversized, or anchorless requests, then continues the normal downstream chain once a relay-ready leaf exists
- readiness interactions are append-only request events: `proposal_presented`, `question_asked`, `question_answered`, `proposal_accepted`, `proposal_edited`
- request-level `next_action` is lightweight routing metadata, not a manifest lifecycle state

## State Machine

Ten states with enforced transitions (`skills/relay-dispatch/scripts/manifest/lifecycle.js:ALLOWED_TRANSITIONS`):

```text
  ┌─────────┐
  │  draft   │──────────────────────────────────────────┐
  └────┬─────┘                                          │
       ↓                                                ↓
  ┌──────────────┐                                  ┌────────┐
  │  dispatched   │──────────────────────────────────┐       │ closed  │
  └──────┬────────┘                                  │       └─────────┘
         ↓                                           ↓           ↑
┌─────────────────────────┐                     ┌───────────┐    │
│ internal_review_pending │─────────────────────│ escalated  │───┘
└──────┬────────────┬─────┘                     └───────────┘
       │            │
       ↓            ↓
┌────────────────┐   ┌──────────────────┐
│ publish_pending│──→│  review_pending  │
└───────┬────────┘   └──┬───────────┬───┘
        │               │           │
        ↓               │           │
   escalated            │           │
                        ↓           ↓
┌────────────────────┐    ┌──────────────────┐
│ changes_requested   │    │  ready_to_merge   │
└────────┬───────────┘    └────┬────────┬──────┘
         │                     │        │
         ↓ (re-dispatch)       │        ↓
    dispatched                 │   ┌────────┐
                               │   │ merged  │←── escalated (already-merged recovery)
                               │   └─────────┘
                               ↓
                         ┌───────────────┐
                         │ merge_blocked │
                         └───────┬───────┘
                                 ↓
                           ready_to_merge
```

`internal_review_pending` is the pre-publication review gate over the retained worktree diff. A passing internal review advances to `publish_pending`, never `ready_to_merge`. `publish_pending` is the only state where `publish-run.js` may push/open the PR and stamp `git.pr_number`; successful publication advances to `review_pending`, while publish preflight or push/PR failures advance to `escalated`.

`review_pending` is the post-publication review gate. It reviews the PR diff plus CI/actions, GitHub review, and PR comment signals. A passing post-publication review advances to `ready_to_merge`.

An `escalated` run may transition directly to `merged` only during already-merged recovery: GitHub must report the PR as MERGED and the fresh review gate must pass for the merged head.

Terminal states: `merged`, `closed`. Once entered, no further transitions. `merge_blocked` is non-terminal: Phase 3 fleet merge queues use it to preserve a failed merge attempt without forcing an invalid review-cycle transition.

## Manifest Schema

Each run produces `~/.relay/runs/<repo-slug>/<run-id>.md` — a Markdown file with YAML frontmatter:

```yaml
---
relay_version: 2
run_id: issue-42-20260403120000000
state: review_pending
next_action: run_review

issue:
  number: 42
  source: github               # github | unknown

coordination:
  marker: relay-orca: example-program-1234abcd/outcome-a  # optional opaque single-line integration correlation

git:
  base_branch: main
  working_branch: issue-42
  pr_number: 128                 # null before publish_pending -> review_pending; review/merge consumers require it after publication
  head_sha: abc123def

github:
  pr_created_by_orchestrator: true   # set when dispatch.js opened or reused the PR

roles:
  orchestrator: codex           # who drives the lifecycle
  executor: codex               # who implements
  reviewer: claude              # who reviews (isolated)

fleet_id: sprint-batch-2        # optional; immutable fleet back-pointer
ownership:                      # required with fleet_id; immutable on resume
  sprint: backlog/sprints/2026-07-relay-fleet.md
  track: 2026-07-relay-fleet
  component: relay-fleet

model_hints:
  dispatch: null                # omit for Codex/Claude managed CLI defaults
  review: null                  # omit for Codex/Claude managed CLI defaults
  advisory_review: example/opencode-model-fast  # optional non-gating advisory reviewer model

paths:
  repo_root: /Users/me/project
  worktree: /tmp/relay-wt-issue-42
  dispatch_stdout: ~/.relay/runs/<repo-slug>/<run-id>/dispatch-stdout.log
  dispatch_stderr: ~/.relay/runs/<repo-slug>/<run-id>/dispatch-stderr.log
  dispatch_result: ~/.relay/runs/<repo-slug>/<run-id>/dispatch-result.txt
  lease: ~/.relay/runs/<repo-slug>/<run-id>/lease.json

policy:
  merge: manual_after_lgtm      # merge strategy
  cleanup: on_close              # when to remove worktree
  reviewer_write: forbid         # reviewer must not mutate code
  review_assurance: standard      # compact | standard | hardened
  executor_network:
    access: disabled             # disabled | enabled
    mechanism: default           # default | sandbox_workspace_write.network_access
    domains: null                # reserved for managed network profile allowlists

anchor:
  done_criteria_source: issue    # issue | unknown
  rubric_source: manifest        # where rubric lives

review:
  rounds: 2
  max_rounds: 2              # compact=1, standard=2, hardened=3
  latest_verdict: pass           # pending | pass | changes_requested | escalated
  repeated_issue_count: 0
  last_reviewed_sha: abc123def
  last_reviewer: codex           # acting reviewer for the most recent round

cleanup:
  status: pending                # pending | succeeded | failed | skipped
  last_attempted_at: null
  cleaned_at: null
  worktree_removed: false
  branch_deleted: false
  prune_ran: false
  error: null

timestamps:
  created_at: "2026-04-03T12:00:00.000Z"
  updated_at: "2026-04-03T13:30:00.000Z"

# Optional; present only when relay-reconcile-artifact is used.
bootstrap_exempt:
  enabled: true
  artifact_path: ~/.relay/runs/project-abcd1234/issue-42-20260403120000000/execution-evidence.json
  writer_pr: 267
  reason: "this run predates the artifact writer"
---

# Notes

## Context

## Review History
```

### Key fields

| Field | Purpose |
|-------|---------|
| `roles.*` | Immutable per-run binding. Decouples who decides, who implements, who validates |
| `fleet_id`, `ownership` | Fleet child lineage and its validated `{sprint, track, component}` finalize owner; immutable on resume |
| `model_hints.*` | Optional per-phase model preference. Current runtime consumers: `dispatch`, `review`, `advisory_review`. For unmanaged harnesses, values must resolve to approved provider/model routes. Do not add Codex/Claude model hints in generated company defaults just to pin their managed CLI model. |
| `dispatch.last_model` / executor config | Dispatch records the effective model route when one exists. The skill-bundled `skills/relay-dispatch/references/executor-models.json` intentionally ships empty; unmanaged executors need an explicit route from CLI/model hints/project routes or a local `~/.relay/executors.json` default, and the selected route still passes through the route policy gate. Codex/Claude managed CLI defaults normally record a null model route. |
| Route policy | Stored outside the manifest in `~/.relay/policy.json`, optional repo-local `.relay/policy.json`, and optional project-local `~/.relay/projects/<repo-slug>/policy.json`. Executor/reviewer names are harnesses; provider/model route strings are the policy boundary. Final operator precedence is `CLI flags / --route-intent-file -> project routes.json -> routing rules -> defaults -> existing relay defaults -> policy gate`. Adapter capability gates run before this policy gate. |
| Route plan | Dispatch writes `route-plan.json` in the run directory with effective dispatch/review/advisory routes, source traces, and policy decisions. The manifest stores only a compact `routes.summary` plus `routes.plan_path` so operators can audit routing without bloating the lifecycle contract. |
| Run-dir runtime artifacts | While dispatch is active, `lease.json` records `{ pid, pgid, host, started_at, timeout_s }` for crash-only reconciliation. `pid` is the dispatch supervisor and `pgid` is the detached executor process group. Executor stdout, stderr, and result output live as `dispatch-stdout.log`, `dispatch-stderr.log`, and `dispatch-result.txt` in the same run directory and are referenced from manifest `paths`. |
| Detached launch receipt | `dispatch.js --detach --json` re-execs dispatch under a detached Node supervisor and returns only after the child has entered `dispatched`, written `lease.json`, and created the real run-dir log files. The receipt includes `runId`, `manifestPath`, `supervisorPid`, `stdoutLog`, `stderrLog`, and `reconcileCommand`; it is a launch contract, not a manifest field. |
| `policy.merge` | `manual_after_lgtm` — orchestrator must explicitly merge |
| `policy.reviewer_write` | `forbid` — review runner rejects rounds where reviewer mutated files |
| `policy.review_assurance` | `compact` gives low-risk work one independent review with the same permission, sandbox, network, repository, SHA, audit, publication, and merge protections; `standard` keeps the bounded two-round default; `hardened` requires stronger review/evidence gates without using agent identity heuristics. Hardened review commands must include an advisory reviewer, and passing verdicts require successful advisory artifacts plus strict execution evidence. When `execution-evidence.json` includes `verification_runs[]`, hardened gates prefer those actual command-run records; legacy evidence without that array still falls back to `test_exit_code=0` plus a SHA-bound result hash |
| `anchor.*` | Immutable review scope — prevents drift across rounds |
| `review.last_reviewed_sha` | Gate-check blocks merge if HEAD has advanced past this |
| `review.last_reviewer` | Tracks the acting reviewer for the latest round without mutating `roles.reviewer`; escalated same-adapter retry requires an `--independent-review-reason`; analytics must still use `review_apply.reviewer` as the round-level source of truth |
| `git.pr_number` / `github.pr_created_by_orchestrator` | Orchestrator-owned push + PR creation persists `git.pr_number` for review/merge consumers; `github.pr_created_by_orchestrator` records whether relay created or reused the PR. In delayed-publication runs these fields stay null/absent until `publish-run.js` advances `publish_pending -> review_pending`. See [ADR-0001](../docs/decisions/0001-orchestrator-owns-publication.md) |
| `bootstrap_exempt.*` | Optional operator-declared reconciliation for runs that predate an artifact writer but are closed after that writer lands |

### Adapter Capability vs Route Policy

Relay evaluates two separate safety layers in this order:

1. Adapter capability gate: validates that the selected CLI adapter can safely perform the requested phase and containment shape. This includes dispatch vs primary review vs advisory review support, read-only semantics, sandbox metadata, and network metadata. Failures are reported as `adapter_capability` and do not imply anything about provider/model approval.
2. Model-route policy gate: validates the effective provider/model route against `~/.relay/policy.json` plus repo-local `.relay/policy.json`. Failures are reported as `policy_decision` and mean the adapter could perform the phase, but the active profile did not allow the route.

Managed Codex/Claude invocations may intentionally have `model: null`; the default route policy treats those model-less managed CLI calls as allowed. Unmanaged routes such as Pi, OpenCode, and Antigravity remain policy-configurable through `allowed_model_routes` and `denied_model_routes`; changing those allow/deny rules must not require adapter code changes.

The supported adapter capability matrix and new-adapter checklist are published in [`skills/relay-dispatch/references/agent-adapter-platform.md`](../skills/relay-dispatch/references/agent-adapter-platform.md). That reference is the source of truth for dispatch, primary-review, advisory-review, sandbox, read-only, network, structured-output, transport, and app-registration support.

### Bootstrap exemptions

`bootstrap_exempt` is absent for normal runs. It is populated only by `relay-reconcile-artifact`, which exists for bootstrap cases where a run cannot satisfy a newly introduced artifact requirement because the run itself produced that writer.

Shape:

```yaml
bootstrap_exempt:
  enabled: true
  artifact_path: <path to the reconciled artifact contract>
  writer_pr: <pull request number that introduced the writer>
  reason: <operator audit reason>
```

Semantics:

- `enabled: true` marks the run as a structured bootstrap exemption; analytics must count this field, not reason-string prefixes.
- `artifact_path` records the artifact contract that the run predates or reconciles.
- `writer_pr` records the PR that introduced the writer or artifact contract.
- `reason` remains an operator-readable audit explanation.
- Re-running `relay-reconcile-artifact` with identical fields against the already merged exempt run is a no-op and does not append another event.
- Existing manifests without this field remain valid and load as non-exempt runs.

## Event Journal

Each run keeps an append-only event log at `~/.relay/runs/<repo-slug>/<run-id>/events.jsonl`. Records are emitted by `appendRunEvent()` in `skills/relay-dispatch/scripts/relay-events.js` and share a common envelope (`ts`, `event`, `actor`, `run_id`, `state_from`, `state_to`, `head_sha`, `round`, `reason`) plus optional fields (`reviewer`, `rubric_status`, `last_reviewed_sha`, `pr_number`, `bootstrap_exempt`, `model`, `executor_network`, `failure_class`, `before`, `after`, `profile`, `status`, `artifact_path`, `raw_response_path`, `elapsed_ms`, `critical_path_wait_ms`, `consumed_by_phase`, `phase_decision_waited`, `frontier_step_replaced`, `failure_reason`, override audit fields):

```jsonl
{"ts":"2026-04-18T12:00:00.000Z","event":"dispatch_start","actor":"codex","run_id":"issue-42-20260418120000000","state_from":"draft","state_to":"dispatched","head_sha":"abc123","round":null,"reason":"new_dispatch","model":null,"executor_network":{"access":"enabled","mechanism":"sandbox_workspace_write.network_access","domains":null},"policy_decision":{"allowed":true,"reason":"managed_cli","phase":"dispatch","actor":"codex","model":null}}
{"ts":"2026-04-18T12:05:00.000Z","event":"dispatch_result","actor":"codex","run_id":"issue-42-20260418120000000","state_from":"dispatched","state_to":"internal_review_pending","head_sha":"def456","round":null,"reason":"new_dispatch:completed","publish_policy":"after-internal-review","executor_network":{"access":"enabled","mechanism":"sandbox_workspace_write.network_access","domains":null},"failure_class":null}
{"ts":"2026-04-18T12:08:00.000Z","event":"review_apply","actor":"claude","run_id":"issue-42-20260418120000000","state_from":"internal_review_pending","state_to":"publish_pending","head_sha":"def456","round":1,"reviewer":"codex","reason":"pass"}
{"ts":"2026-04-18T12:09:00.000Z","event":"publish_result","actor":"codex","run_id":"issue-42-20260418120000000","state_from":"publish_pending","state_to":"review_pending","head_sha":"def456","round":null,"reason":"created_pr","pr_number":128,"branch":"issue-42","pr_created_by_orchestrator":true}
{"ts":"2026-04-18T12:10:00.000Z","event":"review_invoke","actor":"claude","run_id":"issue-42-20260418120000000","state_from":"review_pending","state_to":"review_pending","head_sha":"def456","round":1,"reason":"codex","model":null}
{"ts":"2026-04-18T12:11:00.000Z","event":"advisory_review","actor":"claude","run_id":"issue-42-20260418120000000","state_from":"review_pending","state_to":"review_pending","head_sha":"def456","round":1,"reason":null,"reviewer":"opencode","model":"example/opencode-model-fast","profile":"blindspot","status":"success","artifact_path":"~/.relay/runs/project-abcd1234/issue-42-20260418120000000/review-round-1-advisory-opencode.json","raw_response_path":"~/.relay/runs/project-abcd1234/issue-42-20260418120000000/review-round-1-advisory-opencode-raw-response.txt","required_count":0,"advisory_count":1,"duplicate_low_confidence_count":0,"elapsed_ms":42000,"advisory_elapsed_ms":42000,"critical_path_wait_ms":5000,"consumed_by_phase":"metrics","phase_decision_waited":true,"frontier_step_replaced":false,"failure_reason":null}
{"ts":"2026-04-18T12:12:00.000Z","event":"review_apply","actor":"claude","run_id":"issue-42-20260418120000000","state_from":"review_pending","state_to":"changes_requested","head_sha":"def456","round":1,"reviewer":"codex","reason":"changes_requested"}
{"ts":"2026-04-18T12:40:00.000Z","event":"review_apply","actor":"claude","run_id":"issue-42-20260418120000000","state_from":"review_pending","state_to":"ready_to_merge","head_sha":"ghi789","round":2,"reviewer":"codex","reason":"pass"}
{"ts":"2026-04-18T12:45:00.000Z","event":"merge_finalize","actor":"codex","run_id":"issue-42-20260418120000000","state_from":"ready_to_merge","state_to":"merged","head_sha":"ghi789","round":2,"reason":"squash"}
```

**Source of truth** — `relay-events.js` owns the envelope; event names are emitted across production scripts. To enumerate all events, grep `event:` inside `skills/*/scripts/` (excluding `*.test.js`). Known events today:

| Event | Emitted by |
|-------|------------|
| `dispatch_start`, `dispatch_interrupted`, `dispatch_result`, `environment_drift`, `model_hints_updated` | `relay-dispatch/scripts/dispatch.js`; `reconcile-run.js` may also emit `dispatch_interrupted` when settling dead or timed-out dispatched runs |
| `publish_result` | `relay-dispatch/scripts/publish-run.js` |
| `recover_commit`, `recover_commit_failed`, `execution_evidence_rebranded` | `relay-dispatch/scripts/recover-commit.js`, `rebrand-evidence.js` |
| `iteration_score`, `rubric_quality`, `safety_boundary_violation` | `relay-dispatch/scripts/relay-events.js` (helpers) |
| `close`, `cleanup_result` | `relay-dispatch/scripts/close-run.js`, `cleanup-worktrees.js` |
| `state_recovery` | `relay-dispatch/scripts/recover-state.js`; `reconcile-run.js` emits it for `dispatched -> review_pending` dead-work recovery |
| `review_invoke` | `relay-review/scripts/review-runner/reviewer-invoke.js` |
| `advisory_review` | `relay-review/scripts/review-runner/advisory.js` |
| `review_apply` | `relay-review/scripts/review-runner.js`, `reviewer-invoke.js` |
| `pr_number_stamped`, `merge_blocked`, `skip_review`, `force_finalize`, `merge_finalize`, `cleanup_result` | `relay-merge/scripts/finalize-run.js`, `relay-reconcile-artifact.js`, `gate-check.js` |
| `request_persisted`, `proposal_presented`, `question_asked`, `question_answered`, `proposal_accepted`, `proposal_edited`, `relay_ready_handoff_persisted` | `relay-ready/scripts/relay-request.js` |

There is no standalone `state_transition` event — state changes ride on the lifecycle event that caused them (`state_from`/`state_to` fields on `dispatch_start`, `dispatch_result`, `review_apply`, `merge_finalize`, etc.).

For reviewer analytics, `roles.reviewer` answers "who was assigned to review this run?" while `review_apply.reviewer` answers "who actually executed this review round?". Keep them separate. If a run shows review activity in the manifest but lacks `review_apply` reviewer data, report that gap explicitly rather than backfilling from the assigned role binding.

### Override audit shape

Operator escape hatches remain available, but high-risk override events add a shared audit shape without removing legacy fields:

| Field | Meaning |
|-------|---------|
| `override_class` | Stable class such as `force_finalize_nonready`, `execution_evidence_rebrand`, or `bootstrap_artifact_reconcile` |
| `affected_head_sha` | Commit SHA the override affects or attests after the override |
| `prior_state` | Manifest state observed before the override side effect |
| `required_reason` | Non-empty operator-provided reason, duplicated from `reason` for override-specific queries |
| `operator_initiated` | `true` for deliberate operator escape hatches |
| `independent_attestation` | Optional supplemental attestation when a path has a separate review or verification source |

Current producers are `force_finalize` from `finalize-run --force-finalize-nonready`, bootstrap `force_finalize` from `relay-reconcile-artifact`, and `execution_evidence_rebranded` from `rebrand-evidence` / `recover-commit`. Consumers must treat these fields as additive because older events only have the legacy envelope.

## Review Round Artifacts

Each round produces files under `~/.relay/runs/<repo-slug>/<run-id>/`:

| File | Content |
|------|---------|
| `review-round-N-prompt.md` | Generated review prompt |
| `review-round-N-done-criteria.md` | Frozen Done Criteria snapshot |
| `review-round-N-diff.patch` | Diff at time of review |
| `review-round-N-verdict.json` | Structured verdict |
| `review-round-N-raw-response.txt` | Raw reviewer output |
| `review-round-N-redispatch.md` | Fix prompt (when changes requested) |
| `review-round-N-policy-violation.txt` | If reviewer mutated code |
| `review-round-N-advisory-<reviewer>-prompt.md` | Optional non-gating advisory prompt |
| `review-round-N-advisory-<reviewer>-raw-response.txt` | Optional advisory raw output |
| `review-round-N-advisory-<reviewer>.json` | Optional validated advisory findings |
| `review-round-N-advisory-<reviewer>-policy-violation.txt` | If advisory reviewer mutated code; recorded without manifest escalation in v1 |

## Dispatch Handoff (PR Boundary)

The PR is the handoff boundary between executor and review. After #198, publication is orchestrator-owned, not executor-owned:

- **Executor:** edit and commit inside the retained worktree only.
- **Orchestrator (`dispatch.js`):** push branch with operator shell credentials, open or reuse PR, persist `git.pr_number` (and `github.pr_created_by_orchestrator` when applicable), then transition toward review.
- **Failure:** publication errors escalate the run with `push_or_pr_failed:` — no silent continuation without a PR.

Worktree lifecycle is centralized in `worktree-runtime.js` ([ADR-0003](../docs/decisions/0003-worktree-runtime-single-owner.md)). Manifest logic uses slice modules behind a thin facade ([ADR-0002](../docs/decisions/0002-manifest-slice-ownership.md)). Durable refactor decisions live under [docs/decisions/](../docs/decisions/README.md).

## Module Boundaries (and what they are NOT)

Two patterns look like inconsistencies but are intentional. Both are pinned by tests; mechanical "unification" would break working design.

### `skills/*/` is a packaging boundary, not a runtime boundary

`skills/` exists so users can install individual skills via `npx skills add sungjunlee/dev-relay/<skill>`. At runtime, the boundary is purely how files are packaged — Node imports routinely cross it.

Tests and test fixtures intentionally live under `tests/<skill>/`, not inside `skills/<skill>/`. The skills installer copies each skill directory without a project-specific ignore manifest, so keeping test assets outside `skills/` is the packaging contract that prevents installed skills from carrying repository-only test files.

Current cross-skill imports:

| Importer | Imports from |
|----------|--------------|
| `skills/relay-merge/scripts/gate-check.js` | `relay-review/scripts/review-runner/{context,redispatch}.js`, `relay-dispatch/scripts/manifest/lifecycle.js` |
| `skills/relay-review/scripts/review-runner.js` | `relay-dispatch/scripts/manifest/{lifecycle,paths,store}.js`, `relay-dispatch/scripts/relay-events.js` |
| `skills/relay-ready/scripts/relay-request.js` | `relay-dispatch/scripts/relay-manifest.js` (facade — see below) |
| Consumers of `cli-args.js` and `reviewer-helpers.js` | see [Shared utilities (cross-skill)](#shared-utilities-cross-skill) |

Placement rule for new shared helpers: the skill most often invoked as a dependency hosts the module. Today `relay-dispatch` hosts `cli-args.js`; `relay-review` hosts `reviewer-helpers.js`. Do not introduce a neutral top-level directory — it would contradict the packaging-not-runtime rule above.

### `relay-manifest.js` is a compatibility facade

`skills/relay-dispatch/scripts/relay-manifest.js` is a 17-line re-export-only module that spreads seven `manifest/*` submodules:

```js
module.exports = { ...paths, ...store, ...lifecycle, ...rubric, ...cleanup, ...attempts, ...environment };
```

Convention (from [ADR-0002 manifest slice ownership](../docs/decisions/0002-manifest-slice-ownership.md), issue #188):

- **Runtime code** imports direct submodules: `require("./manifest/lifecycle")`. The docs list every runtime caller and its narrow submodule set.
- **Compatibility tests** (e.g. `relay-manifest.test.js`, `dispatch.test.js`, `close-run.test.js`) and **out-of-scope runtime callers** (today: `relay-ready/scripts/relay-request.js`) continue to import via the facade. Each retained consumer is catalogued in the boundary-split doc with the reason it stayed.

Enforcement: [`manifest-direct-imports.test.js`](../tests/relay-dispatch/scripts/manifest-direct-imports.test.js) asserts the facade stays ≤40 lines with zero function declarations and transitively runs every `manifest/*.test.js`. If the facade regains logic — or if submodules fall out of test — that file fails.

Do not "simplify" the facade by collapsing submodules back into it or by force-migrating the remaining facade consumers. Both moves regress the boundary the test pins.

## Extending

### Adding a new executor

1. Add `skills/relay-dispatch/scripts/executors/<name>.js` exporting the 7-field adapter contract documented in [`agent-adapter-platform.md`](../skills/relay-dispatch/references/agent-adapter-platform.md): `cliBinary`, `defaultTimeout`, `validateExecutionMode`, `buildExecCommand`, `finalizeResult`, `register`, and `probe`.
2. Register the harness descriptor in `skills/relay-dispatch/scripts/agent-adapters/index.js`; update `skills/relay-dispatch/scripts/executors/index.js` only if display order needs a stable compatibility slot.
3. Add behavior-matrix and probe coverage in `tests/relay-dispatch/scripts/executors.test.js`.
4. Add adapter capability policy coverage in `tests/relay-dispatch/scripts/agent-adapter-policy.test.js` and docs consistency coverage in `tests/relay-dispatch/scripts/docs-defaults.test.js`.
5. Optional: implement adapter `register(...)` for dispatch-time app registration; unsupported adapters should return `{threadId: null, raw}`.

### Adding a new reviewer adapter

1. Create `skills/relay-review/scripts/invoke-reviewer-<name>.js`
2. The script is invoked by `review-runner/reviewer-invoke.js:invokeReviewer()` as:
   ```
   node invoke-reviewer-<name>.js --repo <repoPath> --prompt-file <promptPath> --json [--model <name>]
   ```
   The `<promptPath>` bundle already contains the diff, Done Criteria, and rubric — adapters read that single prompt file, not separate `--diff-file` / `--done-criteria-file` flags.
3. Trusted primary adapters must print a JSON verdict to **stdout** matching `REVIEW_VERDICT_JSON_SCHEMA` in `skills/relay-review/scripts/review-schema.js`. `review-runner` captures stdout via `execFileSync({ stdio: "pipe" })` and writes it to `review-round-N-raw-response.txt`; adapters must not write their own output files or mutate the repo.
4. `review-runner.js` auto-discovers adapters via `resolveReviewerScript()` by naming convention: `invoke-reviewer-<name>.js`. The `<name>` must match `/^[a-z0-9-]+$/`.
5. Existing adapters share small utilities (`getArg`, `hasFlag`, `summarizeFailure`, `ensureJsonText`) but NOT full execution logic — each adapter encodes its own execution contract (e.g. Claude uses `--json-schema` + stdout recovery; Codex uses temp-file exchange + `--ephemeral` + sandbox). New adapters should extract only the small utilities.

`invoke-reviewer-cursor.js` supports primary review only: it invokes `agent --print --trust --force --mode ask --workspace <repo> --output-format json`, parses the wrapper `result` field into strict verdict JSON, probes auth via `agent status` or `CURSOR_API_KEY`, and enforces a parent-process timeout via `RELAY_CURSOR_REVIEW_TIMEOUT` (default `1800s`). Relay passes `--workspace` only and never `agent --worktree`.

`invoke-reviewer-opencode.js`, `invoke-reviewer-pi.js`, and `invoke-reviewer-antigravity.js` are phase-aware: `--phase primary_review` validates normal review verdict JSON, while `--phase advisory_review` validates advisory JSON through `advisory-review-schema.js`. OpenCode primary review is route-policy gated and prompt-only read-only with a post-run dirty-worktree guard. Pi invokes `pi --no-session --tools read,grep,find,ls --print <prompt>`, enforces a parent-process timeout via `RELAY_PI_REVIEW_TIMEOUT` (default `1800s`), and uses the same tool allowlist for primary and advisory review. Antigravity targets the `agy` CLI only; it invokes `agy --prompt <prompt> --print-timeout <duration> --sandbox` and relies on dirty-worktree checks rather than Antigravity GUI, IDE, Desktop, plugin runtime, or PTY state. Antigravity live support remains fail-safe experimental until a healthy live canary passes; fake-bin tests alone do not prove live executor or reviewer success, and the fail-safe timeout canary is not healthy success.

### Shared utilities (cross-skill)

Small, pure utilities that multiple skills import live under `skills/relay-dispatch/scripts/` alongside the runtime modules they share kinship with — not in a neutral top-level directory. `skills/` packages independent publishable skills, but at runtime the skill boundary is packaging only (see retro: `gate-check.js` → relay-review internals, `review-runner.js` → relay-dispatch internals). Placement rule: the skill most often invoked as a dependency hosts the shared helper.

Before deleting, moving, or reclassifying scripts, use the script inventory in
[`docs/script-inventory-and-cleanup.md`](../docs/script-inventory-and-cleanup.md).
Zero runtime imports are not enough to prove a script is dead: operator CLIs,
adapter entry points, and archived measurement tools often have no importers.

Current shared helpers:

| Module | Owner | Consumers |
|--------|-------|-----------|
| `skills/relay-dispatch/scripts/cli-args.js` | relay-dispatch | `review-runner.js`, `invoke-reviewer-antigravity.js`, `invoke-reviewer-claude.js`, `invoke-reviewer-codex.js`, `invoke-reviewer-cursor.js`, `invoke-reviewer-opencode.js`, `invoke-reviewer-pi.js`, `finalize-run.js`, `persist-request.js`, `probe-executor-env.js` |
| `skills/relay-review/scripts/reviewer-helpers.js` | relay-review | `invoke-reviewer-antigravity.js`, `invoke-reviewer-claude.js`, `invoke-reviewer-codex.js`, `invoke-reviewer-cursor.js`, `invoke-reviewer-opencode.js`, `invoke-reviewer-pi.js` |

`reviewer-helpers.js` is scoped to JSON recovery/parsing helpers and `summarizeFailure`. Reviewer adapters intentionally keep divergent execution contracts (Claude uses `--json-schema` + stdout recovery; Codex uses temp schema/result files + `--ephemeral` + sandbox; OpenCode uses prompt-enforced read-only behavior), so a full adapter factory would hide meaningful differences. See item 5 under "Adding a new reviewer adapter" above.

Call sites take a local-wrapper pattern so inline flag lists (`KNOWN_FLAGS`) keep acting as fail-closed `reservedFlags`:

```js
const { getArg: sharedGetArg, hasFlag: sharedHasFlag } = require("../../relay-dispatch/scripts/cli-args");
const getArg = (flag, fallback) => sharedGetArg(args, flag, fallback, { reservedFlags: KNOWN_FLAGS });
const hasFlag = (flag) => sharedHasFlag(args, flag);
```

This keeps behavior identical to the original inline helpers while centralizing the `--*` look-alike guard and the reserved-flag handling.

### Role binding

Roles are set at manifest creation time in `createManifestSkeleton()`:
```js
roles: {
  orchestrator: "codex",   // or "claude", future: any agent
  executor: "codex",
  reviewer: "claude",
}
```

At review time, `--reviewer` (or `RELAY_REVIEWER`) selects the acting reviewer for the round. The assigned `roles.reviewer` binding stays immutable; the acting reviewer is recorded in `review.last_reviewer` and the `review_apply` event payload. Reporting that compares Codex vs Claude review execution should read `review_apply.reviewer`, not `roles.reviewer`.
