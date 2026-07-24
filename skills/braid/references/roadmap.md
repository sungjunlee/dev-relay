# braid — status and roadmap (start here for a new session)

This is the pick-up doc. If you are resuming braid in a fresh session, read this first, then
[design.md](design.md) for the full rationale and [plan-format.md](plan-format.md) for the input
shape. braid is the successor to the frozen `relay-orca` ([../../relay-orca/SUPERSEDED.md](../../relay-orca/SUPERSEDED.md)).

## Where braid is (v0, shipped)

- **Thesis:** decompose deep, execute flat. A cheap decomposition tree (internal nodes are pure
  structure, no lifecycle); ordinary `relay` runs only at the leaves; a parent is `done` only when
  every child is done-with-durable-evidence. That recursive **evidence fold** is the whole product.
- **Shipped surface (read-only):** `validate` and `status`. No dispatch, no supervision, no runtime
  coupling. Leaves are driven by ordinary `relay`.
- **Code:** `scripts/lib/fold.js` (~100 lines, the heart), `scripts/lib/plan.js` (tree validator),
  `scripts/lib/manifest.js` (tiny relay-manifest reader), `scripts/braid.js` (the only I/O boundary).
  The `lib/` modules are pure; all I/O is in the CLI.
- **Tests:** `tests/braid/scripts/{fold,plan,manifest}.test.js` (42 tests). Independent code review
  verified the fold/dependency/validator logic correct.
- **Live-verified:** braid folded the real merged #1063/#1067/#1066 iteration tree to `COMPLETE`
  purely from relay manifests, and surfaced `ready` leaves + dep-gating on a partial tree.

## Run it

```bash
node skills/braid/scripts/braid.js validate --plan <plan.json>
node skills/braid/scripts/braid.js status  --plan <plan.json> --repo-slug <slug> --json
node --test tests/braid/scripts/*.test.js
```

A worked plan lives inline in [plan-format.md](plan-format.md); the status output shows per-node
status, whole-tree `complete`, and `ready_leaves` (what to drive through relay next).

## What v0 proved (and only this)

1. The fold is reliable from durable evidence alone (never a signal).
2. Dependency ordering falls out of the same fold as pure data — no live loop.
3. The base case is human-marked: you declare a node a leaf when it is small enough for one relay run.

## Next candidates (prioritized)

1. **Live issue-close verification (v1's first job).** Today `status: merged` is trusted as the
   merge+close record, so the fold's "merged PR but issue still open → `blocked`" branch is
   unreachable end-to-end (see the v0 acceptance in design.md). The `durableFacts(manifest, overrides)`
   seam already accepts a live result — wire an optional `gh issue view` per merged leaf so that
   branch becomes real. Keep it opt-in / graceful when `gh` is absent.
2. **Dogfood a real goal.** Decompose one genuine multi-part goal into a braid tree and drive it
   end-to-end through relay. This is the cheapest way to pressure-test the two open unknowns: is the
   human base-case judgment stable, and does the fold read cleanly in practice? Do this BEFORE
   building any heuristic — let the pain point the next feature.
3. **A `next` convenience.** Print each `ready` leaf as a copy-paste `relay` invocation (issue/task +
   suggested route), so the operator loop is: `braid status` → run the printed `relay` commands →
   record `run_id`s → repeat until `complete`.
4. **Auto-map leaf → relay run** (drop the explicit `run_id`): discover a leaf's run by matching its
   `issue` against `~/.relay/runs/<slug>/` manifests. Convenience; low priority; keep the exact,
   no-guessing default available.
5. **Base-case heuristic** (suggest when a node is "one relay run" sized). Only after dogfood shows
   the manual judgment is the real friction. Never auto-split below a human-declared leaf.

## Deliberately deferred (do not build until the above earn it)

Autonomous raw-intent decomposition; any live coordinator loop or dispatch from braid; runtime
coupling (durable state stays relay manifests + git); depth-triggered integration gates and
cross-tree wave materialization. These are exactly the machinery that made relay-orca heavy.

## Open design questions (decide when a real case forces them)

- Should a `blocked` subtree halt dispatch of *independent* siblings? v0 says no — `readyLeaves` is
  `depends_on`-only, so an unrelated ready leaf still surfaces even while another subtree is blocked
  (tested). Revisit only if a real program wants "stop the world on any block."
- How does a leaf that is itself a **fan-out** interact with `relay-fleet`? v0 treats every leaf as
  one `relay` run; a fleet-shaped leaf is out of scope until a real case appears.
- How deep is actually useful? v0 imposes no depth limit; watch whether real trees stay shallow.

## Hard guardrail

Lightness is the point. The new logic that matters is the fold; leaves reuse relay. If braid grows
past a few hundred lines of real logic for the "next candidates," stop and reconsider — that growth
is the relay-orca failure mode returning. Keep the human as the decomposer until a real case proves
a heuristic is safe.
