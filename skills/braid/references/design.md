# braid — design and rationale

braid is the successor to the frozen `relay-orca` ([../../relay-orca/SUPERSEDED.md](../../relay-orca/SUPERSEDED.md)).
It keeps the principles relay-orca proved and drops the machinery it disproved.

## Thesis: decompose deep, execute flat

The goal is a lightweight way to take one accepted piece of work and split it recursively into a
tree of smaller pieces, do the small pieces, and reassemble — without losing control the way a
deep supervised control plane does.

The insight from relay-orca: **supervision and orchestration should not be one thing.** relay-orca
coupled them and got heavy (~10k LOC, a runtime-bound receipt, a coordinator-provenance contract,
a one-layer ceiling). braid separates them:

- **Decomposition is deep and cheap.** Internal tree nodes are pure structure — no lifecycle, no
  manifest, no runtime state. Just "this work = these sub-works".
- **Execution accountability is flat.** Ordinary `relay` runs, already trustworthy and
  evidence-gated, do the work at the **leaves** and nowhere else.
- **Aggregation is a fold, not a state machine.** A parent is `done` iff every child is
  `done-with-durable-evidence`. `braid status` reads relay manifests and folds — it never runs a
  live coordinator loop and never couples to a session/runtime id.

Good human orgs work this way: plan deep, keep execution accountability flat.

## Principles carried from relay-orca (non-negotiable)

1. **Evidence over signals** — `done` comes only from durable truth (merged PR + closed issue),
   never from `worker_done` or task status.
2. **Fail closed on ambiguity** — a leaf that went terminal without merged+closed is `blocked`,
   and `blocked` dominates a parent's fold; nothing advances on unclear state.
3. **Frozen anchors** — each leaf is an ordinary relay run with its own frozen Done Criteria; braid
   adds no second review contract.
4. **No runtime coupling** — durable state lives in relay manifests + git, not in any braid- or
   session-owned lifecycle.

## What v0 proves (and only this)

- **The fold is reliable from durable evidence alone.** Verified against real merged runs: braid
  folded the actual #1063/#1067/#1066 iteration tree to `complete` purely from relay manifests.
- **Dependency ordering is pure data.** `ready` leaves fall out of the same fold, no live loop.
- **The base case is human-marked.** You declare a leaf when it is small enough for one relay run;
  v0 exists partly to exercise that judgment before any heuristic automates it.

## v0 acceptance: `state: merged` is trusted as the merge+close record

braid's headline is "done only on merged PR + closed issue." In v0 the CLI reads that from the
relay manifest's `state` field alone: it trusts `state: merged` to mean both, because relay's
finalize-run sets `merged` only after a squash-merge whose `Fixes #N` closes the issue. This is a
**deliberate v0 acceptance**, not an oversight — its consequence is that the fold's
"merged PR but the issue is somehow still open → `blocked`" branch is unreachable through the
default path (only a `closed`/abandoned run reaches `blocked` end-to-end). The branch stays in the
code, unit-tested, and becomes reachable the moment live issue re-verification is wired: the
`durableFacts(manifest, overrides)` seam accepts a live `gh issue view` result as `issue_closed`.
Given this repo's own history of merged-PR-but-open-issue cases, wiring that live check is the
first thing a v1 should add.

## Deliberately deferred (until the fold + base-case earn it)

- Autonomous raw-intent decomposition (the human/planning pass owns the tree in v0).
- Any live coordinator loop or dispatch from braid itself (leaves are driven by ordinary relay).
- Depth-triggered integration gates and cross-tree wave materialization.
- Auto-mapping a leaf to its relay run (v0 uses an explicit `run_id`).

If braid ever grows past a few hundred lines of real logic for these, that is the signal to stop
and reconsider — lightness is the whole point.
