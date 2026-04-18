# Relay Architecture Reference

Deep-dive into the manifest contract, state machine, and extension points. For overview, see [CLAUDE.md](../CLAUDE.md).

This reference centers on the manifest-backed run lifecycle, plus the intake boundary that may sit ahead of `relay-plan`. For the full intake control-flow contract, see [docs/relay-intake-routing-and-handoff-design.md](../docs/relay-intake-routing-and-handoff-design.md).

## Intake Boundary

Before a run manifest exists, raw work may live in relay-intake artifacts under `~/.relay/requests/<repo-slug>/`.

```text
raw request
  -> relay-intake request artifact + events
  -> relay-ready handoff brief(s) + frozen Done Criteria snapshot(s)
  -> relay-plan
  -> relay-dispatch run manifest
  -> relay-review
  -> relay-merge
```

Boundary rules:

- `/relay` remains the public front door for full-cycle execution
- `/relay` bypasses intake only for issue-first or task-first inputs that are already relay-sized and already have a trustworthy review anchor
- `/relay` invokes intake for ambiguous, oversized, or anchorless requests, then continues the normal downstream chain once a relay-ready leaf exists
- intake interactions are append-only request events: `proposal_presented`, `question_asked`, `question_answered`, `proposal_accepted`, `proposal_edited`
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

paths:
  repo_root: /Users/me/project
  worktree: /tmp/relay-wt-issue-42

policy:
  merge: manual_after_lgtm      # merge strategy
  cleanup: on_close              # when to remove worktree
  reviewer_write: forbid         # reviewer must not mutate code

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
---

# Notes

## Context

## Review History
```

### Key fields

| Field | Purpose |
|-------|---------|
| `roles.*` | Immutable per-run binding. Decouples who decides, who implements, who validates |
| `model_hints.*` | Optional advisory per-phase model preference. Current runtime consumers: `dispatch`, `review` |
| `policy.merge` | `manual_after_lgtm` — orchestrator must explicitly merge |
| `policy.reviewer_write` | `forbid` — review runner rejects rounds where reviewer mutated files |
| `anchor.*` | Immutable review scope — prevents drift across rounds |
| `review.last_reviewed_sha` | Gate-check blocks merge if HEAD has advanced past this |
| `review.last_reviewer` | Tracks the acting reviewer for the latest round without mutating `roles.reviewer`; analytics must still use `review_apply.reviewer` as the round-level source of truth |

## Event Journal

Each run keeps an append-only event log at `~/.relay/runs/<repo-slug>/<run-id>/events.jsonl`:

```jsonl
{"event":"dispatch_started","timestamp":"...","executor":"codex","branch":"issue-42"}
{"event":"dispatch_completed","timestamp":"...","status":"completed","runState":"review_pending"}
{"event":"review_apply","timestamp":"...","round":1,"reviewer":"codex","reason":"changes_requested"}
{"event":"review_apply","timestamp":"...","round":2,"reviewer":"codex","reason":"pass"}
{"event":"state_transition","timestamp":"...","from":"review_pending","to":"ready_to_merge"}
```

For reviewer analytics, `roles.reviewer` answers "who was assigned to review this run?" while `review_apply.reviewer` answers "who actually executed this review round?". Keep them separate. If a run shows review activity in the manifest but lacks `review_apply` reviewer data, report that gap explicitly rather than backfilling from the assigned role binding.

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

## Extending

### Adding a new executor

1. **`dispatch.js` line ~181**: Add entry to `EXECUTOR_CLI` map
   ```js
   const EXECUTOR_CLI = { codex: "codex", gemini: "gemini-cli" };
   ```

2. **`dispatch.js` line ~396**: Add execution branch
   ```js
   } else if (EXECUTOR === "gemini") {
     cmd = "gemini-cli";
     execArgs = ["run", "--dir", wtPath, ...];
     // ...
   }
   ```

3. **Optional**: App registration uses `create-worktree.js --register` (executor-agnostic)

### Adding a new reviewer adapter

1. Create `skills/relay-review/scripts/invoke-reviewer-<name>.js`
2. The script receives: `--diff-file`, `--done-criteria-file`, `--prompt-file`, `--output-file`
3. It must write a JSON verdict to `--output-file` matching the schema in `review-schema.js`
4. `review-runner.js` auto-discovers adapters by naming convention: `invoke-reviewer-<name>.js`

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
