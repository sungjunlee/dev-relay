# Rubric Pattern — Event Shape Changes

Use this pattern when a quality factor concerns event schema evolution.
The rubric must name the complete event tuple, not just the newly added field.

## Field presence

Name the new marker field exactly and require the literal value expected. The
literal value proves the new shape was emitted by the intended path.

Do not write "includes the new marker." Write the assertion:

```yaml
criteria: "`review_apply` event includes `origin: \"system\"`"
```

## Field absence

Name related fields that must not appear when the event is system-generated.
This prevents implementations from satisfying the new field while preserving
an incompatible legacy shape.

For a system-forced review transition, the event must not invent reviewer-only
fields that imply a human or model review round ran.

## State context

Pin the event to the transition that generates it. Include `state_to`,
`state_from`, round number, or other tuple members needed to distinguish the
target event from similar emissions.

For escalation paths, require the terminal state and the policy reason rather
than checking only the event name.

## Legacy shape tolerance

Schema evolution rubrics must also protect old manifests and event journals.
State explicitly that pre-change events emitted without the new marker still
parse and retain their original meaning.

This is a compatibility assertion, not a request to backfill historical events.

**Worked example: `max_rounds_exceeded` -> `review_apply`**

For #228, the rubric factor should enumerate all four assertions:

```yaml
criteria: >
  When the review round cap is exceeded, the emitted `review_apply` event has
  `origin: "system"`, keeps reviewer-only fields absent, records
  `state_to: ESCALATED`, and records `reason: "max_rounds_exceeded"`.
  Legacy `review_apply` events emitted before `origin` existed still parse.
```

Concrete checks:

- Field presence: `origin` is present with the literal value `"system"`.
- Field absence: reviewer-only fields remain absent for the system transition.
- State context: `state_to: ESCALATED` and `reason: "max_rounds_exceeded"`.
- Legacy shape tolerance: older events without `origin` still parse correctly.
