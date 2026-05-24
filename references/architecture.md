# Relay Architecture Reference

Deep-dive into the manifest contract, state machine, and extension points. For overview, see [CLAUDE.md](../CLAUDE.md).

This reference centers on the manifest-backed run lifecycle, plus the readiness boundary that may sit ahead of `relay-plan`. For the full relay-ready control-flow contract, see [docs/relay-ready-routing-and-handoff-design.md](../docs/relay-ready-routing-and-handoff-design.md).

## Readiness Boundary

Before a run manifest exists, raw work may live in relay-ready artifacts under `~/.relay/requests/<repo-slug>/`.

```text
raw request
  -> relay-ready request artifact + events
  -> relay-ready handoff brief(s) + frozen Done Criteria snapshot(s)
  -> relay-plan
  -> relay-dispatch run manifest
  -> relay-review
  -> relay-merge
```

Boundary rules:

- `/relay` remains the public front door for full-cycle execution
- `/relay` bypasses relay-ready only for issue-first or task-first inputs that are already relay-sized and already have a trustworthy review anchor
- `/relay` invokes relay-ready for ambiguous, oversized, or anchorless requests, then continues the normal downstream chain once a relay-ready leaf exists
- readiness interactions are append-only request events: `proposal_presented`, `question_asked`, `question_answered`, `proposal_accepted`, `proposal_edited`
- request-level `next_action` is lightweight routing metadata, not a manifest lifecycle state

## State Machine

Eight states with enforced transitions (`relay-manifest.js:ALLOWED_TRANSITIONS`):

```
  ┌─────────┐
  │  draft   │──────────────────────────────────────────┐
  └────┬─────┘                                          │
       ↓                                                ↓
  ┌──────────────┐                                  ┌────────┐
  │  dispatched   │──────────────────────────┐       │ closed  │
  └──────┬────────┘                          │       └─────────┘
         ↓                                   ↓           ↑
  ┌──────────────────┐                  ┌───────────┐    │
  │  review_pending   │─────────────────│ escalated  │───┘
  └──┬───────────┬───┘                  └───────────┘
     │           │
     ↓           ↓
┌────────────────────┐    ┌──────────────────┐
│ changes_requested   │    │  ready_to_merge   │
└────────┬───────────┘    └────────┬──────────┘
         │                         │
         ↓ (re-dispatch)           ↓
    dispatched                 ┌────────┐
                               │ merged  │
                               └─────────┘
```

Terminal states: `merged`, `closed`. Once entered, no further transitions.

## Manifest Schema

Each run produces `~/.relay/runs/<repo-slug>/<run-id>.md` — a Markdown file with YAML frontmatter:

```yaml
---
relay_version: 2
run_id: issue-42-20260403120000000
state: review_pending
next_action: start_review

issue:
  number: 42
  source: github               # github | unknown

git:
  base_branch: main
  working_branch: issue-42
  pr_number: 128
  head_sha: abc123def

roles:
  orchestrator: codex           # who drives the lifecycle
  executor: codex               # who implements
  reviewer: claude              # who reviews (isolated)

model_hints:
  dispatch: opus                # optional per-phase advisory model preference
  review: haiku                 # optional per-phase advisory model preference
  advisory_review: opencode-go/deepseek-v4-pro  # optional non-gating advisory reviewer model

paths:
  repo_root: /Users/me/project
  worktree: /tmp/relay-wt-issue-42

policy:
  merge: manual_after_lgtm      # merge strategy
  cleanup: on_close              # when to remove worktree
  reviewer_write: forbid         # reviewer must not mutate code
  review_assurance: standard      # standard | hardened
  executor_network:
    access: disabled             # disabled | enabled
    mechanism: default           # default | sandbox_workspace_write.network_access
    domains: null                # reserved for managed network profile allowlists

anchor:
  done_criteria_source: issue    # issue | unknown
  rubric_source: manifest        # where rubric lives

review:
  rounds: 2
  max_rounds: 20
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
| `model_hints.*` | Optional advisory per-phase model preference. Current runtime consumers: `dispatch`, `review`, `advisory_review` |
| `dispatch.last_model` / executor config | Dispatch records the effective model. If no explicit model hint is present, executor defaults come from the skill-bundled `skills/relay-dispatch/references/executor-models.json` plus optional `~/.relay/executors.json` overrides |
| `policy.merge` | `manual_after_lgtm` — orchestrator must explicitly merge |
| `policy.reviewer_write` | `forbid` — review runner rejects rounds where reviewer mutated files |
| `policy.review_assurance` | `standard` keeps current behavior; `hardened` requires stronger review/evidence gates without using agent identity heuristics. Hardened review commands must include an advisory reviewer, and passing verdicts require successful advisory artifacts plus strict execution evidence. When `execution-evidence.json` includes `verification_runs[]`, hardened gates prefer those actual command-run records; legacy evidence without that array still falls back to `test_exit_code=0` plus a SHA-bound result hash |
| `anchor.*` | Immutable review scope — prevents drift across rounds |
| `review.last_reviewed_sha` | Gate-check blocks merge if HEAD has advanced past this |
| `review.last_reviewer` | Tracks the acting reviewer for the latest round without mutating `roles.reviewer`; escalated same-adapter retry requires an `--independent-review-reason`; analytics must still use `review_apply.reviewer` as the round-level source of truth |
| `bootstrap_exempt.*` | Optional operator-declared reconciliation for runs that predate an artifact writer but are closed after that writer lands |

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

Each run keeps an append-only event log at `~/.relay/runs/<repo-slug>/<run-id>/events.jsonl`. Records are emitted by `appendRunEvent()` in `skills/relay-dispatch/scripts/relay-events.js` and share a common envelope (`ts`, `event`, `actor`, `run_id`, `state_from`, `state_to`, `head_sha`, `round`, `reason`) plus optional fields (`reviewer`, `rubric_status`, `last_reviewed_sha`, `pr_number`, `bootstrap_exempt`, `model`, `executor_network`, `failure_class`, `before`, `after`, `profile`, `status`, `artifact_path`, `raw_response_path`, `elapsed_ms`, `failure_reason`, override audit fields):

```jsonl
{"ts":"2026-04-18T12:00:00.000Z","event":"dispatch_start","actor":"codex","run_id":"issue-42-20260418120000000","state_from":"draft","state_to":"dispatched","head_sha":"abc123","round":null,"reason":"new_dispatch","model":"gpt-5-codex","executor_network":{"access":"enabled","mechanism":"sandbox_workspace_write.network_access","domains":null}}
{"ts":"2026-04-18T12:05:00.000Z","event":"dispatch_result","actor":"codex","run_id":"issue-42-20260418120000000","state_from":"dispatched","state_to":"review_pending","head_sha":"def456","round":null,"reason":"new_dispatch:completed","executor_network":{"access":"enabled","mechanism":"sandbox_workspace_write.network_access","domains":null},"failure_class":null}
{"ts":"2026-04-18T12:10:00.000Z","event":"review_invoke","actor":"claude","run_id":"issue-42-20260418120000000","state_from":"review_pending","state_to":"review_pending","head_sha":"def456","round":1,"reason":"codex","model":"haiku"}
{"ts":"2026-04-18T12:11:00.000Z","event":"advisory_review","actor":"claude","run_id":"issue-42-20260418120000000","state_from":"review_pending","state_to":"review_pending","head_sha":"def456","round":1,"reason":null,"reviewer":"opencode","model":"opencode-go/deepseek-v4-pro","profile":"blindspot","status":"success","artifact_path":"~/.relay/runs/project-abcd1234/issue-42-20260418120000000/review-round-1-advisory-opencode.json","raw_response_path":"~/.relay/runs/project-abcd1234/issue-42-20260418120000000/review-round-1-advisory-opencode-raw-response.txt","required_count":0,"advisory_count":1,"duplicate_low_confidence_count":0,"elapsed_ms":42000,"failure_reason":null}
{"ts":"2026-04-18T12:12:00.000Z","event":"review_apply","actor":"claude","run_id":"issue-42-20260418120000000","state_from":"review_pending","state_to":"changes_requested","head_sha":"def456","round":1,"reviewer":"codex","reason":"changes_requested"}
{"ts":"2026-04-18T12:40:00.000Z","event":"review_apply","actor":"claude","run_id":"issue-42-20260418120000000","state_from":"review_pending","state_to":"ready_to_merge","head_sha":"ghi789","round":2,"reviewer":"codex","reason":"pass"}
{"ts":"2026-04-18T12:45:00.000Z","event":"merge_finalize","actor":"codex","run_id":"issue-42-20260418120000000","state_from":"ready_to_merge","state_to":"merged","head_sha":"ghi789","round":2,"reason":"squash"}
```

**Source of truth** — `relay-events.js` owns the envelope; event names are emitted across production scripts. To enumerate all events, grep `event:` inside `skills/*/scripts/` (excluding `*.test.js`). Known events today:

| Event | Emitted by |
|-------|------------|
| `dispatch_start`, `dispatch_result`, `environment_drift`, `model_hints_updated` | `relay-dispatch/scripts/dispatch.js` |
| `recover_commit`, `recover_commit_failed`, `execution_evidence_rebranded` | `relay-dispatch/scripts/recover-commit.js`, `rebrand-evidence.js` |
| `iteration_score`, `rubric_quality`, `score_divergence` | `relay-dispatch/scripts/relay-events.js` (helpers) |
| `close`, `cleanup_result` | `relay-dispatch/scripts/close-run.js`, `cleanup-worktrees.js` |
| `state_recovery` | `relay-dispatch/scripts/recover-state.js` |
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
| `override_class` | Stable class such as `force_finalize_nonready` or `execution_evidence_rebrand` |
| `affected_head_sha` | Commit SHA the override affects or attests after the override |
| `prior_state` | Manifest state observed before the override side effect |
| `required_reason` | Non-empty operator-provided reason, duplicated from `reason` for override-specific queries |
| `operator_initiated` | `true` for deliberate operator escape hatches |
| `independent_attestation` | Optional supplemental attestation when a path has a separate review or verification source |

Current producers are `force_finalize` from `finalize-run --force-finalize-nonready` and `execution_evidence_rebranded` from `rebrand-evidence` / `recover-commit`. Consumers must treat these fields as additive because older events only have the legacy envelope.

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

Convention (from [#188 manifest boundary split](../docs/issue-188-manifest-boundary-split.md)):

- **Runtime code** imports direct submodules: `require("./manifest/lifecycle")`. The docs list every runtime caller and its narrow submodule set.
- **Compatibility tests** (e.g. `relay-manifest.test.js`, `dispatch.test.js`, `close-run.test.js`) and **out-of-scope runtime callers** (today: `relay-ready/scripts/relay-request.js`) continue to import via the facade. Each retained consumer is catalogued in the boundary-split doc with the reason it stayed.

Enforcement: [`manifest-direct-imports.test.js`](../tests/relay-dispatch/scripts/manifest-direct-imports.test.js) asserts the facade stays ≤40 lines with zero function declarations and transitively runs every `manifest/*.test.js`. If the facade regains logic — or if submodules fall out of test — that file fails.

Do not "simplify" the facade by collapsing submodules back into it or by force-migrating the remaining facade consumers. Both moves regress the boundary the test pins.

## Extending

### Adding a new executor

1. Add `skills/relay-dispatch/scripts/executors/<name>.js` exporting the 6-field adapter contract.
2. Register it in `skills/relay-dispatch/scripts/executors/index.js`.
3. Add behavior-matrix coverage in `tests/relay-dispatch/scripts/executors.test.js`.
4. Optional: implement adapter `register(...)` for dispatch-time app registration.

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

`invoke-reviewer-opencode.js` is currently advisory-only: `review-runner --advisory-reviewer opencode` invokes it with a separate blind-spot prompt and validates output through `advisory-review-schema.js`, not the trusted verdict schema. Do not use opencode as the primary `--reviewer` until a trusted verdict adapter exists for it.

### Shared utilities (cross-skill)

Small, pure utilities that multiple skills import live under `skills/relay-dispatch/scripts/` alongside the runtime modules they share kinship with — not in a neutral top-level directory. `skills/` packages independent publishable skills, but at runtime the skill boundary is packaging only (see retro: `gate-check.js` → relay-review internals, `review-runner.js` → relay-dispatch internals). Placement rule: the skill most often invoked as a dependency hosts the shared helper.

Before deleting, moving, or reclassifying scripts, use the script inventory in
[`docs/script-inventory-and-cleanup.md`](../docs/script-inventory-and-cleanup.md).
Zero runtime imports are not enough to prove a script is dead: operator CLIs,
adapter entry points, and archived measurement tools often have no importers.

Current shared helpers:

| Module | Owner | Consumers |
|--------|-------|-----------|
| `skills/relay-dispatch/scripts/cli-args.js` | relay-dispatch | `review-runner.js`, `invoke-reviewer-claude.js`, `invoke-reviewer-codex.js`, `invoke-reviewer-opencode.js`, `finalize-run.js`, `persist-request.js`, `probe-executor-env.js` |
| `skills/relay-review/scripts/reviewer-helpers.js` | relay-review | `invoke-reviewer-claude.js`, `invoke-reviewer-codex.js`, `invoke-reviewer-opencode.js` |

`reviewer-helpers.js` is scoped to `summarizeFailure` and `ensureJsonText`. Reviewer adapters intentionally keep divergent execution contracts (Claude uses `--json-schema` + stdout recovery; Codex uses temp schema/result files + `--ephemeral` + sandbox; opencode is advisory-only with prompt-enforced read-only behavior), so a full adapter factory would hide meaningful differences. See item 5 under "Adding a new reviewer adapter" above.

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
