# Workflow Lane Policy

Status: policy documentation, not a router. dev-relay does not select a lane
for you and does not auto-promote a fast task into a relay run. Pick the lane
that matches the task. If you cross an escalation threshold mid-flight, stop
and re-pick.

## The Lanes

| Lane | What it is | Best for |
|------|------------|----------|
| **Fast** | Direct edit + you verify. No Relay run. | Tiny, reversible work. |
| **Goal** | Same-thread completion loop with self-audit. | Multi-step work that stays in one context. |
| **Relay** | Git-required, forge-optional lifecycle: source gate → plan → dispatch in worktree → independent reviewer in fresh context → local Reviewed Result or ready_to_merge gate → explicit merge on GitHub. | High-risk, cross-agent work. Planner ≠ reviewer. |
| **Review-only** | Independent review of an already-implemented exact Git result. No dispatch. | Code someone else already implemented. |

## Quick decision table

| Task shape | Default lane |
|------------|--------------|
| One-line dead-code removal, typo, doc cross-link | **Fast** |
| Single function rewrite you can verify in your head | **Fast** |
| Multi-step refactor inside one module | **Goal** |
| Cross-skill, schema, prompt-template, or invariant change | **Relay** |
| Auth boundary, inspect-derived action, merge gate, recovery path | **Relay** |
| Someone else already pushed a branch + PR | **Review-only** |
| Triage finding or follow-up suggestion | Do not take a lane; leave a comment or issue. |

## Escalation thresholds (fast/goal → relay)

Stop and switch to relay if **any one** is true:

1. **Trust boundary.** Auth, capability, sandbox, secret, or merge-gate path.
2. **Cross-skill blast radius.** Two or more skills, or a shared module.
3. **Contract change.** New fact type, run field, schema enum, derived action,
   or CLI flag with audit semantics.
4. **You wrote the prompt and the verification matters.** The relay reviewer
   scores the diff against frozen Done Criteria, not the prompt.
5. **Dead-end loop.** Two failed self-audit cycles on the same fix.

Cheaper moves: Fast → Goal when a hidden extra step appeared; Goal →
Review-only when a PR exists and you want a fresh-context check; Goal → Relay
when the next pass would be the third and there is still no rubric.

De-escalation: if a relay task shrinks to a one-line fix, close the relay PR
without merging and reship as Fast.

## Examples

**Fast:** `finalize-run.js --help` shows the wrong `--merge-method` default.
One-line constant plus the existing `--help` golden test. If the bug were in
merge-method dispatch, the lane would be Relay.

**Relay:** add a new inspect-derived action with its own gate behavior. Plan a
rubric that names every gate the new action must pass. A same-thread self-audit
will miss a consumer it never opened.

**Review-only:** a previous session opened PR `#N`. Anchor a relay run to that
head with no dispatch. If review returns `changes_requested`, re-dispatch or
close.

## What this is not

- **Not a router.** No `relay-route` skill and no automatic promotion.
- **Not a tool dependency.** Codex `/goal`, gstack, superpowers, and Compound
  Engineering may sit around a lane. Relay scripts and tests do not import
  them. If they disappear, the lanes remain.
- **Not a merge policy.** Fast-lane changes still need to pass CI. Relay-lane
  changes still need a passing review plus `gate-check.js`.
