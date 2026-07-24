---
name: braid
description: Decompose one accepted goal into a cheap tree of relay-able leaves, then fold relay's durable evidence back up — a node is done only when every child is done-with-evidence. v0 is read-only (validate/status); leaves are driven by ordinary relay.
compatibility: Requires Node.js 18+. Reads relay run manifests under ${RELAY_HOME:-~/.relay}/runs/. No Orca, no new runtime.
argument-hint: status --plan <braid-plan.json> --repo-slug <slug>
metadata:
  related-skills: relay, relay-dispatch, relay-review, relay-merge, relay-fleet
  keywords: braid, decompose, decomposition tree, evidence fold, work breakdown, leaves, deep tree
---

## Inputs
- Files: a human-authored **braid plan** (JSON) describing a decomposition tree. Schema: [references/plan-format.md](references/plan-format.md).
- Env: `RELAY_HOME` (defaults to `~/.relay`) locates relay run manifests; `--repo-slug` (or `BRAID_REPO_SLUG`) selects the repo's runs directory.
- Script: `${RELAY_SKILL_ROOT:-skills}/braid/scripts/braid.js` (the only I/O boundary; the `lib/` fold and plan modules are pure).

# braid

> **v0 — experimental, read-only.** braid decomposes work deep and executes it flat. It does **not** dispatch, supervise, or couple to any runtime; ordinary `relay` runs do the work at the leaves and braid folds their durable evidence back up. Design and rationale: [references/design.md](references/design.md).

## The idea

**Decompose deep, execute flat.** One accepted goal becomes a *cheap* tree: internal nodes are pure structure with no lifecycle, and every leaf is one relay-able unit. A leaf is `done` only when its relay run reached durable truth (merged PR + closed issue) — never from a `worker_done` signal. A parent is `done` only when **every** child is `done`. That "done = fold of children's durable evidence" is braid's whole thesis; it is a recursive fold, not a state machine.

## Use when

- You have one accepted goal that is too big for a single `relay` run and naturally splits into a tree of smaller relay-able pieces, and you want to track roll-up completion and see what is ready to work next.

## Do not use when

- One tracker-backed outcome fits a single run — use `relay`.
- A flat set of already-planned independent leaves — use `relay-fleet`.
- You want autonomous raw-intent decomposition — **not in v0**; you (or a planning pass) author the tree.

## Intents (v0)

| Intent | I/O | Purpose |
| --- | --- | --- |
| `validate` | read-only | Check a braid plan's tree shape, unique ids, and acyclic `depends_on`. |
| `status` | read-only | Fold relay manifests over the tree: per-node status, whether the whole tree is complete, and which leaves are ready to dispatch next. |

braid v0 performs **no** mutation: no dispatch, no manifest/receipt write, no Orca, no `gh` write.

## Commands

```bash
# validate a decomposition tree
node "${RELAY_SKILL_ROOT:-skills}/braid/scripts/braid.js" validate --plan /tmp/goal.braid.json

# fold relay's durable evidence over the tree (read-only)
node "${RELAY_SKILL_ROOT:-skills}/braid/scripts/braid.js" status --plan /tmp/goal.braid.json --repo-slug <repo-slug> --json
```

## How leaves get done

braid never dispatches. For each leaf that `status` reports `ready`, drive it through ordinary `relay` (readiness → plan → dispatch → review → merge). Once merged, record the run id in the leaf's `run_id` so the next `status` folds it as `done`. When the root folds to `done`, the goal is complete on durable evidence.

## Status meanings

- `not_started` — no relay run mapped yet (leaf), or all children untouched (internal).
- `running` — a relay run is in flight, or children are mixed.
- `done` — leaf reached merged + closed; internal node has every child `done`.
- `blocked` — fail-closed: a leaf's relay run went terminal without merged+closed (abandoned/superseded), or any descendant is blocked. Needs a human.

## v0 boundaries (deliberately deferred)

No autonomous decomposition, no live coordinator loop, no runtime coupling, no depth-triggered gates. These come only after the base-case heuristic and the fold are proven. See [references/design.md](references/design.md).
