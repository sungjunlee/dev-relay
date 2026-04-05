# Relay Architecture Reference

Deep-dive into the manifest contract, state machine, and extension points. For overview, see [CLAUDE.md](../CLAUDE.md).

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

Each run produces `.relay/runs/<run-id>.md` — a Markdown file with YAML frontmatter:

```yaml
---
relay_version: 1
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
| `policy.merge` | `manual_after_lgtm` — orchestrator must explicitly merge |
| `policy.reviewer_write` | `forbid` — review runner rejects rounds where reviewer mutated files |
| `anchor.*` | Immutable review scope — prevents drift across rounds |
| `review.last_reviewed_sha` | Gate-check blocks merge if HEAD has advanced past this |

## Event Journal

Each run keeps an append-only event log at `.relay/runs/<run-id>/events.jsonl`:

```jsonl
{"event":"dispatch_started","timestamp":"...","executor":"codex","branch":"issue-42"}
{"event":"dispatch_completed","timestamp":"...","status":"completed","runState":"review_pending"}
{"event":"review_round","timestamp":"...","round":1,"reviewer":"codex","verdict":"changes_requested"}
{"event":"review_round","timestamp":"...","round":2,"reviewer":"codex","verdict":"pass"}
{"event":"state_transition","timestamp":"...","from":"review_pending","to":"ready_to_merge"}
```

## Review Round Artifacts

Each round produces files under `.relay/runs/<run-id>/`:

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

The `RELAY_REVIEWER` environment variable and `--reviewer` flag override the manifest default at review time.
