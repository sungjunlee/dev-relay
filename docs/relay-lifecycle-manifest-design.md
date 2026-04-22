# Relay Lifecycle Manifest Design

> Drafted 2026-04-02 as the foundation for #34, #35, #36, #37, #38, and #39.
>
> Updated 2026-04-03 for the same-run control loop wave (#41-#46): `run_id` is now the canonical identity, every run gets an append-only `events.jsonl`, review records `last_reviewed_sha`, merge requires a fresh review at current HEAD, and stale non-terminal runs have an explicit close path.

## Summary

dev-relay currently describes a strong workflow, but most of the runtime contract lives in prose:

- what the worker should do
- what the reviewer should verify
- when to re-dispatch
- when to merge
- when to clean up worktrees

That works inconsistently across models because the lifecycle is implicit. This document defines a manifest-backed run model so Claude and Codex can both act as orchestrator, worker, or reviewer without relying on undocumented behavior.

## Goals

- Keep relay tool-neutral across Claude and Codex
- Move lifecycle state out of transient prompts and into a shared run file
- Make review rounds script-managed instead of instruction-only
- Keep worktrees alive through review and re-dispatch by default
- Change the default terminal state from `merged` to `ready_to_merge`

## Non-goals

- No daemon or central database
- No requirement to use Codex app-server or Claude-specific internals
- No removal of GitHub issue, PR, or sprint-file surfaces

## Design Principles

1. The manifest is the source of truth for relay run state.
2. Scripts own lifecycle transitions.
3. Models produce work artifacts and judgments, not hidden state.
4. Review is no-write by default.
5. Merge is explicit after LGTM, not implicit.

## Proposed Layout

Each relay run gets a repo-local directory:

```text
.relay/
  runs/
    <run-id>.md
    <run-id>/
      dispatch-prompt.md
      review-input.json
      review-result.json
      logs/
```

The `.md` file is the canonical run manifest. The sibling directory holds artifacts that are useful for debugging, review, and replay.

## Manifest Format

Use Markdown with YAML frontmatter:

- YAML frontmatter: machine-readable contract
- Markdown body: human notes, rationale, round summaries, audit details

Example:

```md
---
relay_version: 1
run_id: issue-42-20260402-103000
state: review_pending
next_action: run_review

issue:
  number: 42
  source: github

git:
  base_branch: main
  working_branch: issue-42
  pr_number: 128

roles:
  orchestrator: codex
  executor: claude
  reviewer: codex

paths:
  repo_root: /abs/repo
  worktree: /abs/worktree

policy:
  merge: manual_after_lgtm
  cleanup: on_close
  reviewer_write: forbid

anchor:
  done_criteria_source: issue
  rubric_source: manifest

review:
  rounds: 1
  max_rounds: 20
  latest_verdict: changes_requested
  repeated_issue_count: 0

cleanup:
  status: pending
  last_attempted_at: null
  cleaned_at: null
  worktree_removed: false
  branch_deleted: false
  prune_ran: false
  error: null

timestamps:
  created_at: 2026-04-02T10:30:00Z
  updated_at: 2026-04-02T11:05:00Z
---

# Notes

## Context

## Review History
```

## Required Fields

The initial schema should stay minimal.

| Field | Purpose | Owner |
|---|---|---|
| `relay_version` | Schema version | manifest creator |
| `run_id` | Stable run identifier | manifest creator |
| `state` | Current lifecycle state | scripts only |
| `next_action` | Immediate next step | scripts only |
| `issue.number` | Task anchor | planner/init |
| `git.base_branch` | Merge target | planner/init |
| `git.working_branch` | Worker branch | dispatch |
| `git.pr_number` | PR association | dispatch/review |
| `roles.*` | Which model does what | planner/init |
| `paths.worktree` | Worktree reuse point | dispatch |
| `policy.merge` | Merge behavior | planner/init |
| `policy.cleanup` | Cleanup behavior | planner/init |
| `policy.reviewer_write` | Review write policy | planner/init |
| `anchor.*` | Immutable review anchor metadata | planner/init |
| `review.rounds` | Round counter | review runner |
| `review.latest_verdict` | Latest structured outcome | review runner |
| `cleanup.*` | Cleanup outcome and residue | merge/janitor |

## Source of Truth vs Derived Data

Source-of-truth fields:

- `state`
- `next_action`
- `roles`
- `paths.worktree`
- `policy.*`
- `review.rounds`
- `review.latest_verdict`
- immutable anchor snapshot references

Derived fields:

- PR URL
- worktree cleanliness
- branch divergence
- check summaries
- latest review issue counts

Derived data may be cached in artifacts, but the lifecycle should not depend on those caches being current.

## Lifecycle States

The run state should be explicit and finite.

| State | Meaning |
|---|---|
| `draft` | Manifest exists, dispatch has not started |
| `dispatched` | Worker is running or has been launched |
| `review_pending` | Worker completed enough to review |
| `changes_requested` | Reviewer found issues; targeted fix required |
| `ready_to_merge` | Review passed; waiting for explicit merge |
| `merged` | PR merged |
| `escalated` | Relay cannot safely continue autonomously |
| `closed` | Run intentionally ended without merge |

## Allowed Transitions

| From | To | Trigger |
|---|---|---|
| `draft` | `dispatched` | dispatch starts |
| `dispatched` | `review_pending` | worker completed and produced reviewable output |
| `dispatched` | `escalated` | worker failed unrecoverably |
| `review_pending` | `changes_requested` | reviewer returns issues |
| `review_pending` | `ready_to_merge` | reviewer passes |
| `review_pending` | `escalated` | reviewer cannot continue safely |
| `changes_requested` | `dispatched` | targeted re-dispatch begins |
| `ready_to_merge` | `merged` | explicit merge performed |
| `ready_to_merge` | `closed` | user declines merge / closes run |
| `escalated` | `closed` | user closes run |

Invalid transitions should fail fast.

## Phase Responsibilities

### Planner / Initializer

Responsible for:

- creating the manifest
- setting roles
- snapshotting the anchor source references
- selecting merge and cleanup policy

Not responsible for:

- incrementing review rounds
- deciding merge completion

### Dispatch

Responsible for:

- creating or reusing a worktree
- launching the worker
- attaching branch / PR metadata to the manifest
- transitioning `draft -> dispatched`
- transitioning `dispatched -> review_pending` on success
- preserving the worktree by default

Not responsible for:

- deleting the worktree after success by default
- deciding that the run is complete

### Review Runner

Responsible for:

- loading the immutable anchor
- incrementing `review.rounds`
- invoking the reviewer in an isolated path
- validating structured review output
- transitioning to `changes_requested`, `ready_to_merge`, or `escalated`
- writing PR audit comments
- generating targeted re-dispatch artifacts when needed

Not responsible for:

- directly editing code in the reviewed run

### Merge

Responsible for:

- verifying `ready_to_merge`
- checking review gate requirements
- performing the explicit merge
- transitioning to `merged`
- triggering cleanup according to policy
- recording cleanup success or failure without overloading lifecycle state

## Review Contract

The reviewer model should return a structured verdict. A first-pass schema is:

```json
{
  "verdict": "pass",
  "contract_status": "pass",
  "quality_review_status": "pass",
  "quality_execution_status": "pass",
  "next_action": "ready_to_merge",
  "issues": [],
  "rubric_scores": []
}
```

Allowed `verdict` values:

- `pass`
- `changes_requested`
- `escalated`

Every issue should include:

- `title`
- `body`
- `file`
- `line`
- `category`
- `severity`

The review runner should reject malformed verdicts instead of guessing.

## Worker Contract

The worker can remain prompt-driven, but the run should produce structured metadata that the dispatch layer can attach to the manifest:

- branch used
- PR number if created
- completion status
- whether manual review is now possible

This can stay lightweight at first. The main shift is that dispatch updates the manifest instead of only printing a text summary.

## Policies

### Merge Policy

Default:

```yaml
policy:
  merge: manual_after_lgtm
```

Implication:

- relay should stop at `ready_to_merge`
- merge remains an explicit user or `relay-merge` action

Future extensions may allow:

- `auto_merge`
- `never_merge`

### Cleanup Policy

Default:

```yaml
policy:
  cleanup: on_close
```

Implication:

- worktrees survive dispatch success
- cleanup happens after merge or explicit close
- cleanup result lives in `cleanup.*`, not by forcing `merged -> closed`

Future extensions may allow:

- `on_merge`
- `never`

### Reviewer Write Policy

Default:

```yaml
policy:
  reviewer_write: forbid
```

Implication:

- prefer read-only reviewer execution where possible
- otherwise detect reviewer-written diffs and fail the review run

## Why Markdown + Frontmatter

Why not pure JSON/YAML:

- worse for long-form notes and review history
- less pleasant to inspect in GitHub

Why not prose-only Markdown:

- too weak as a runtime contract

Markdown with frontmatter keeps the run readable in a PR while giving scripts stable fields to parse.

## First Implementation Slice

Issue #37 should stay narrow. It should not try to land the whole lifecycle refactor.

Recommended scope for the first slice:

1. Add a manifest file format and location
2. Add a small shared helper to read and write manifest frontmatter
3. Add state constants and transition validation
4. Create manifests during relay initialization or dispatch setup
5. Persist the minimal required fields only

Do not include in the first slice:

- full review runner
- merge gating changes
- executor-specific adapters
- app-server integration

## Suggested Implementation Order

1. `#37` manifest contract + helper utilities
2. `#39` dispatch writes manifest state and stops auto-cleanup
3. `#35` review runner uses manifest and structured verdicts
4. `#38` reviewer no-write enforcement
5. `#36` ready-to-merge terminal flow

## Open Questions

These do not block the first slice:

- Should artifacts live beside the manifest or in one shared run log file?
- Should the manifest snapshot the full rubric body or store a reference plus checksum?
- Should review comments be rewritten in place or appended per round?
- Should relay support multiple PRs for one manifest, or explicitly forbid branch hopping?

## Decision

Proceed with a manifest-backed lifecycle. Treat this document as the design anchor for the first implementation wave.
