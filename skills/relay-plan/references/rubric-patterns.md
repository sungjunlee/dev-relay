# Relay Done Criteria and Rubric Patterns

This is current planning guidance. Dated issue examples and retired manifest
surfaces belong in `docs/archive/`; they are not a source of runtime commands.

A TDD-oriented planning hint is planner judgment, never a dispatch or review
authority: consider `tdd_anchor` when the probe reports a usable test runner and
an automated contract factor still has no anchor; skip the hint when the rubric
already opts in or the repo reports no test infrastructure. See `SKILL.md` §
Risk-Triggered Add-Ons and `rubric-design-guide.md`.

## Freeze the outcome, not a process script

Done Criteria must describe observable completion, scope, and verification. A
criterion should not require an internal state transition, a particular recovery
command, a review-round count, an app registration, or an evidence sidecar.

```yaml
- name: exact merge authorization is bound to the reviewed source SHA
  tier: contract
  type: automated
  command: node --test tests/relay-merge/scripts/finalize-run.test.js
  target: exit 0
```

Name a required path or command literally when the deliverable depends on it.
If alternatives are acceptable, state their shared behavior rather than making
a brittle grep token the contract.

## Scope boundaries

List the allowed production paths and their directly supporting tests. For
cross-skill work, name the shared contract being changed and each consumer.
Protect archives, generated historical records, unrelated workflow files, and
unrelated executor adapters unless they are named deliverables.

Use a tight `forbidden_zones` list only when the risk justifies it. It must not
freeze a required producer or force a duplicate implementation. Before freezing
the criteria, confirm that every required behavior has an allowed writer.

## Trust-boundary changes

For a claim about immutable inputs, facts, locks, external observations, or
merge authority, include all three:

1. the exact gate function that rejects a forged or stale claim;
2. the independent bytes/fact/observer that proves it; and
3. a focused regression test that demonstrates failure before side effects.

See `rubric-trust-model.md` for the audit template.

## Verification

Prefer deterministic project commands and exact expected outcomes. State the
scope of a measurement honestly: a focused E2E repetition is not a full-suite
flake claim. New tests must be registered in the generated test ledger;
runtime scripts and cross-skill imports must appear in the generated runtime
inventory.

## Keep it small

One criterion should prove one outcome. Avoid redundant scoring dimensions and
model-specific process advice. The immutable Done Criteria is the review anchor;
rubrics help planning but do not create a second runtime authority.
