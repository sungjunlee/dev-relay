# braid plan format (v0)

A braid plan is a human-authored JSON decomposition tree. v0 has no autonomous decomposition —
you (or a thin planning pass) write the tree; braid validates it and folds relay's evidence over it.

## Shape

```jsonc
{
  "braid": {
    "id": "some-goal",              // REQUIRED — stable program id
    "root": {                        // REQUIRED — the root node
      "id": "root",                  // REQUIRED — unique, non-empty
      "children": [                  // internal node: non-empty children, NO `leaf`
        {
          "id": "leaf-a",
          "leaf": { "issue": 1063, "run_id": "issue-1063-..." }   // leaf: has `leaf`, NO children
        },
        {
          "id": "wave-2",
          "depends_on": ["leaf-a"],  // optional — ids that must be `done` first
          "children": [
            { "id": "leaf-b", "leaf": { "task": "free-text task when there is no issue yet" } }
          ]
        }
      ]
    }
  }
}
```

The root may be `{ "braid": {...} }` or the bare plan object.

## Rules

- A node is a **leaf** iff it has `leaf` and no `children`; **internal** iff it has a non-empty
  `children` array and no `leaf`. A node that is both, or neither, is rejected.
- `leaf` must carry an integer `issue` **or** a non-empty `task`. Optional `run_id` maps the leaf
  to its relay run manifest; without a `run_id` the leaf reads as `not_started`.
- `id`s are unique across the whole tree.
- `depends_on` lists ids that must be `done` before this node (and its leaves) become `ready`.
  Unknown references, self-references, and cycles are rejected.

## The base case (v0)

You mark the base case by hand: a node is a leaf when it is small enough to be **one** relay run.
Getting that judgment right is the thing v0 exists to exercise — see [design.md](design.md). Later
versions may suggest a base-case heuristic, but braid will never split below a leaf you declared.
