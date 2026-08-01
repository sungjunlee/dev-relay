# Evaluation Channels

Relay planning produces three distinct channels. Keep them separate in the structured
`evaluation.schema_version: 2` artifact passed through the compatibility-named
`--rubric-file` boundary.

## Authority Hierarchy

1. **Outcome Contract** defines required results and explicit non-goals. It is the
   pass/fail authority and is anchored by frozen Done Criteria.
2. **Verification** defines executable or observable evidence that the Outcome Contract
   was met. A check can prove a requirement but cannot create or expand one.
3. **Earned Rubric** contains optional quality gradients that distinguish meaningfully
   different contract-satisfying results. It cannot waive the contract or turn routine
   hygiene into quality.

Outcome Contract outranks Verification, and Verification outranks Earned Rubric when
signals conflict. A planning result with zero Earned Rubric factors is valid and must
not block dispatch.

## Structured Artifact

```yaml
evaluation:
  schema_version: 2
  outcome_contract:
    source: done_criteria
    path: "<frozen Done Criteria path or issue anchor>"
  verification:
    checks:
      - name: "Focused behavior passes"
        type: command
        command: "node --test tests/focused.test.js"
        target: "exit 0"
  observation:
    artifact: "<artifact or behavior being evaluated>"
    intended_user: "<person affected by the result>"
    usage_context: "<conditions in which the result is used>"
    surfaces:
      - kind: "<rendered_output, reader_walkthrough, operational_replay, ...>"
        target: "<observable target>"
    inquiry:
      contract_satisfying_failure: "<how a correct result could still fail in use>"
      expert_notice: "<what a domain expert would notice that a generic checklist misses>"
    lenses: []
  earned_rubric:
    factors: []
```

Verification check types may be `command`, `observation`, or `artifact`. Tests, builds,
type checks, lint, artifact existence, and equivalent binary evidence belong here by
default. A binary task-specific behavior remains in the Outcome Contract; its command or
observation belongs in Verification.

Earned Rubric eligibility and observation-driven derivation are defined separately.
Until a real quality gradient is found, leave `factors: []`.

## Observe Before Deriving Quality

Before proposing a quality dimension, identify the artifact, intended user, usage context,
and available observation surfaces. Ask both how a contract-satisfying result
could still fail and what a domain expert would notice that a generic checklist misses.
Missing required observation blocks unsupported quality claims instead of producing
invented scores.

Use `observation-lenses.md` only to expand these questions. Lenses are optional and
non-binding: select, combine, replace, or omit them. A design lens requires rendered output
through relevant user flows and viewports; code inspection alone is not design
observation. Non-visual work uses its own available surfaces and does not inherit a
browser requirement.

## Earned Rubric Eligibility

A proposed factor is earned only when all four properties hold:

1. **Gradient**: contract-satisfying results can differ meaningfully.
2. **Observable**: weak, adequate, and strong outcomes can be distinguished in the
   artifact or behavior.
3. **Actionable**: a lower assessment gives a useful improvement direction.
4. **Consequential**: the difference materially affects users, maintainability,
   reliability, security, operability, or another engineering outcome.

Ground every factor in task-specific `evidence`. Generic labels such as "code quality"
or "best practices" do not qualify on their own. Describe qualitative
`anchors.weak`, `anchors.adequate`, and `anchors.strong` first. A `numeric_scale` is
optional and should appear only when it improves comparison, optimization, or another
real decision.

The fixtures under `tests/relay-plan/fixtures/evaluation/` demonstrate valid planning
results with zero, one, and several earned factors.

## Transition Compatibility

Existing `rubric:` artifacts remain readable for in-flight and persisted runs. Runtime
consumers classify them as legacy:

- legacy `prerequisites` continue to act as verification;
- legacy `tier: contract` factors retain pass/fail review meaning;
- legacy `tier: quality` factors retain scored review meaning.

New planning artifacts use the structured channels. Do not rewrite an in-flight legacy
artifact merely to change its schema.
