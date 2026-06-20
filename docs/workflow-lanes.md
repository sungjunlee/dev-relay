# Workflow Lane Policy

Status: policy documentation, not a router. dev-relay does not select a lane for you, does not auto-promote a "fast" task into a "relay" run, and does not depend on Codex `/goal`, gstack, superpowers, or Compound Engineering being installed. Pick the lane that matches the task. If you cross an escalation threshold mid-flight, stop and re-pick.

This doc exists because the toolchain now has multiple legitimate ways to drive a single change end-to-end. Without an explicit policy, every task drifts toward the heaviest available lane (relay) or the lightest one (direct) depending on whoever is at the keyboard. Both extremes waste effort.

## The Lanes

| Lane | What it is | Where it lives | Best for | Cost |
|------|------------|----------------|----------|------|
| **Fast** | Direct Codex/Claude edit + you verify (or invoke a small review skill). No manifest, no run-id, no isolated reviewer. | The chat session you're already in. | Tiny, low-risk, easily-reversible work. Single-file edits. Doc typos. Dead-code removal. | Lowest. No lifecycle artifacts. You are the audit trail. |
| **Goal** | Codex `/goal` (or equivalent same-thread completion loop). The agent runs a self-audit against its stated goal in the same context. | Inside one Codex thread. | Multi-step but **same-context** work where the agent should self-check before reporting done — refactor sweeps, follow a checklist, complete a wired-up feature. | Low-to-mid. Audit lives in chat history; no PR-bound artifact unless the agent opens one. |
| **Relay** | Manifest-backed lifecycle: plan → dispatch in worktree → independent reviewer in fresh context → ready_to_merge gate → explicit merge. | `~/.relay/runs/<repo-slug>/<run-id>.md` + a real PR. | High-risk, PR-bound, cross-agent work. Anything where "I wrote the prompt, so I'm checking my own assumptions" is a real failure mode. | Highest. Run-id, worktree, review rounds, force-finalize escapes. |
| **Review-only** | `relay-review` (or equivalent independent review) over an already-implemented PR. No dispatch round. | A relay run anchored to an existing branch + PR; orchestrator + reviewer roles only. | Code that someone else (human or another agent) already shipped to a PR but you want a fresh-context review against criteria. | Mid. Skips dispatch cost; still pays manifest + review setup. |
| **Sidecar** | Advisory async artifact: an audit comment, an observation note, a triage report. Does not block a merge. | A PR comment, a `backlog/triage/*.md` file, a one-off issue body. | Capture a finding without owning the fix. Suggest a follow-up without taking the lane. | Lowest. Documentation-only. |

## Quick decision table

If the task is…

| Task shape | Default lane | Notes |
|------------|--------------|-------|
| 1-line dead-code removal, typo, doc cross-link fix | **Fast** | Relay would be pure overhead. |
| Single function rewrite, focused tests, you can verify in your head | **Fast** | Verify yourself; consider a small review skill if the change touches a security or invariant boundary. |
| Multi-step refactor inside one module, agent needs to self-check before declaring done | **Goal** | Use Codex `/goal` so the executor maps its own objectives → artifacts. |
| Cross-skill change, schema change, prompt-template change, anything where the planner ≠ reviewer test matters | **Relay** | This is where dev-relay earns its weight. |
| Auth boundary, state-machine transition, merge gate, recovery path | **Relay** | Independent reviewer in fresh context is non-negotiable. |
| Someone else (or a previous session) already pushed a branch + PR | **Review-only** | Anchor a relay run to the existing PR; skip dispatch. |
| Triage finding, audit observation, follow-up suggestion | **Sidecar** | Capture as PR comment / triage file / standalone issue; do not take the lane. |

## Escalation thresholds (fast/goal → relay)

Stop and switch to relay if **any one** is true:

1. **Trust boundary.** The change touches an auth, capability, sandbox, secret, or merge-gate path. Self-review is not enough — the reviewer must not be the planner.
2. **Cross-skill blast radius.** The change spans two or more skills, or modifies a shared module that other skills import. Same-thread audit cannot see consumers it never opened.
3. **State-machine or contract change.** Any new event type, new manifest field, new schema enum, new transition, new CLI flag with audit semantics. Consumer enumeration must happen in a fresh-context review (memory `feedback_consumer_first_gate`).
4. **You wrote the prompt and the verification matters.** If the task only "passes" because your own framing said it should, escalate. The relay reviewer ignores the prompt and scores the diff against frozen Done Criteria.
5. **You hit a dead-end loop in fast/goal.** Two failed self-audit cycles on the same fix. The compounding cost is now higher than dispatching once with a rubric.

Cheaper escalations:

- **Fast → Goal** when the task grew an extra step you didn't see at first. Hand the executor a clean goal in one thread instead of nudging it line-by-line.
- **Goal → Review-only** when the agent finished + opened a PR but you want a fresh-context check before merge. You don't need a re-dispatch; you need a reviewer.
- **Goal → Relay** when the next iteration would be the executor's third pass and there's still no rubric. At that point dispatch the same fix with a rubric instead of looping.

De-escalation works too: a "real relay" task that turned out to be a 1-line fix should be closed without merging the relay PR and reshipped as a fast-lane edit. Relay's overhead is paid up-front; if the task shrinks, eat the sunk cost.

## Examples

### Small bugfix — Fast
> "`finalize-run.js --help` shows wrong default for `--merge-method`."

Lane: **Fast**. One-line constant fix + the existing `--help` golden test. No reviewer-vs-planner risk: the help text is its own audit.

If the bug were in the actual merge-method dispatch (state-machine path), the lane would change to relay.

### Risky state-machine change — Relay
> "Add a new `superseded` lineage value with its own gate behavior."

Lane: **Relay**. Hits all four escalation criteria: state-machine change, schema change, cross-skill (planner + dispatcher + reviewer + gate), and the consumer enumeration problem. Plan a rubric that names every gate the new lineage must pass through (memory `feedback_rubric_feature_state_matrix`). Dispatch in worktree. Reviewer in fresh context will catch the gate the planner forgot.

A goal-lane Codex thread will pass its own self-audit on this and ship a contract gap. Don't do it.

### Docs sync — Fast (or Sidecar)
> "Update CLAUDE.md Common Commands after a CLI rename."

Lane: **Fast**. Doc edit; the rename PR already paid the review cost. If the rename PR hasn't merged yet, this is a **Sidecar** observation on that PR instead of its own lane.

Exception: if the doc is the *only* place the new behavior is described (no schema, no help text), promote to **Goal** so the agent self-checks the doc against the actual code.

### Review-only PR — Review-only
> "A previous orchestrator session opened PR #N for issue #M. I want a fresh-context review before deciding to merge."

Lane: **Review-only**. Anchor a relay run to the existing branch with no dispatch round. The reviewer scores the diff against the frozen Done Criteria from the original issue. If the review escalates to `changes_requested`, you decide whether to re-dispatch (then it becomes a normal relay run) or close.

This is the lane to use after `/codex:rescue` produces a branch you didn't plan. Same shape: the work happened elsewhere; you want fresh-eyes review.

## What this is *not*

- **Not a router.** No `relay-route` skill. No `/relay-pick-lane`. No automatic promotion from goal to relay based on heuristics.
- **Not a dependency declaration.** Codex `/goal` is referenced as one shape of the goal lane. The lane works with any same-thread completion-loop tool. If `/goal` disappears, the policy survives.
- **Not a competitor to gstack/superpowers/CE.** Those tools live around the lanes; the lane is "where the change executes," the tools shape "how planning, debugging, and review happen inside the lane." See [external-tool workflow doc](./external-tool-workflow.md).
- **Not a merge policy.** Merge gates remain enforced by `gate-check.js` regardless of lane. Fast-lane changes still need to pass CI; relay-lane changes still need rubric PASS + gate-check OK.

## Related

- Epic: [#366](https://github.com/sungjunlee/dev-relay/issues/366) — workflow lane policy for relay, Codex goal, gstack, superpowers, CE, and opencode
- Companion: [#370](https://github.com/sungjunlee/dev-relay/issues/370) — borrow Codex goal completion-audit wording into relay dispatch prompts (strengthens the **goal-style audit** *inside* a relay run, without merging the lanes).
- Companion: [#371](https://github.com/sungjunlee/dev-relay/issues/371) — gstack, superpowers, and Compound Engineering usage around relay.
