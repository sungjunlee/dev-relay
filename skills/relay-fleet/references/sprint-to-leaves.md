# Sprint batch to leaves recipe

## Source of truth

The dev-backlog sprint-state JSON is the source of truth for sprint wave intake.
Use `next_batch`, not sprint markdown parsing, as the machine-readable batch:

```json
{
  "next_batch": {
    "heading": "### Batch 2 - Relay fleet docs",
    "items": []
  }
}
```

`next_batch` is the first Plan batch containing unchecked items. Its `items[]`
entries expose `issue_number`, `title`, `state`, `checkbox_state`,
`batch_heading`, `pr`, `run_id`, `branch`, and `unmoored`.

This recipe relies on dev-backlog's `next_batch Batch Semantics` contract:
"Plan mode guarantees batch-as-wave semantics: items in one batch MUST be
mutually parallel-safe (disjoint files, no ordering between them), dependent
items MUST appear in a later batch, and batch order is execution order. A
machine consumer, such as relay-fleet fan-out, MAY treat all `state:todo` items
in `next_batch.items` as concurrently dispatchable under that guarantee."

## Mapping

Create one relay-fleet leaves file from one `next_batch` object. Include only
items whose `state` is `todo` and whose `run_id`, `branch`, and `pr` are all
`null`. Any non-null trace pointer means the sprint item is already in flight
and MUST be excluded from the new fleet.

| Sprint-state field | Relay-fleet output | Rule |
| --- | --- | --- |
| `next_batch.heading` | fleet id wave label | Record the batch heading in the operator-chosen `--fleet-id`, for example `sprint-2026-07-batch-2-relay-fleet-docs`. The leaves file itself contains only `leaves[]`. |
| `items[].batch_heading` | fleet id wave label check | MUST match `next_batch.heading` for batched plans; use it as a per-item sanity check before fan-out. |
| `items[].issue_number` | `leaves[].issue_number` | Copy the integer directly. |
| `items[].title` | `leaves[].leaf_ref`, `leaves[].branch` | Derive both as `issue-<N>-<short-slug>`, where `<N>` is `issue_number` and `<short-slug>` is made from `title` after removing estimate text such as `(~2hr)`, lowercasing, replacing non-alphanumeric runs with `-`, trimming leading/trailing `-`, taking the first five slug tokens, and capping at 48 characters without a trailing `-`. If the slug would be empty, use `task`. |
| `items[].state` | inclusion filter | Include only `state: "todo"` items. Do not dispatch `in_flight` or `done` items. |
| `items[].checkbox_state` | inclusion audit | The included items should be unchecked Plan entries. Treat any mismatch between `state` and `checkbox_state` as a sprint-state problem to resolve before fan-out. |
| `items[].run_id` | exclusion trace | If non-null, exclude the item; an existing relay run already owns it. |
| `items[].branch` | exclusion trace | If non-null, exclude the item; an existing branch already owns it. Do not reuse it for a new leaf. |
| `items[].pr` | exclusion trace | If non-null, exclude the item; an existing PR already owns it. |
| `items[].unmoored` | operator warning | A `todo` item should normally be `false`; if it appears on an excluded or inconsistent row, resolve sprint bookkeeping before fan-out. |
| relay-ready artifact, when present | `leaves[].request_id`, `leaves[].leaf_id` | Optional lineage fields. Include them only when relay-ready persisted a request/leaf handoff for this item; sprint-state does not invent them. |
| relay-plan artifacts | `leaves[].prompt_file`, `leaves[].rubric_file`, `leaves[].done_criteria_file` | Required per leaf. These are authored before fan-out; see the planning boundary below. |

Example shape after filtering and planning:

```json
{
  "leaves": [
    {
      "leaf_ref": "issue-847-sprint-to-leaves-recipe",
      "issue_number": 847,
      "branch": "issue-847-sprint-to-leaves-recipe",
      "prompt_file": "/tmp/relay/847/prompt.md",
      "rubric_file": "/tmp/relay/847/rubric.yaml",
      "done_criteria_file": "/tmp/relay/847/done-criteria.md"
    }
  ]
}
```

## Planning boundary

The mapping above produces structure only. It never bypasses `relay-ready` or
`relay-plan`.

Each included sprint item MUST have a prepared `prompt_file`, `rubric_file`, and
`done_criteria_file` before `relay-fleet` runs. `relay-plan` authors those files
per leaf. If the sprint item is ambiguous, under-scoped, or lacks trustworthy
Done Criteria, run `relay-ready` first and then feed its leaf handoff into
`relay-plan`.

Do not generate placeholder prompts, rubrics, or Done Criteria from
`next_batch.items[]`. The fleet layer fans out prepared relay contracts; it does
not perform planning.

## Wave and write rules

Run one fleet per sprint batch. A `next_batch` is one parallel-safe wave, so the
new leaves file SHOULD NOT prefill same-wave `depends_on` entries. If an item
depends on another sprint item, dev-backlog's batch contract requires that
dependent work to appear in a later batch.

Start the next batch's fleet only after the previous fleet's children are merged
and the corresponding sprint Plan items are marked `[x]`. Batch order is
execution order.

Sprint-file writes are single-writer. The orchestrator session performs
`[ ] -> [~] -> [x]` transitions, branch/run/PR annotations, and `## Progress`
entries. Fleet children MUST NOT write under `backlog/`; doing so creates a
multi-worktree source-of-truth hazard.
