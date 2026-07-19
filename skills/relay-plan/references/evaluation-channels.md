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
  earned_rubric:
    factors: []
```

Verification check types may be `command`, `observation`, or `artifact`. Tests, builds,
type checks, lint, artifact existence, and equivalent binary evidence belong here by
default. A binary task-specific behavior remains in the Outcome Contract; its command or
observation belongs in Verification.

Earned Rubric eligibility and observation-driven derivation are defined separately.
Until a real quality gradient is found, leave `factors: []`.

## Transition Compatibility

Existing `rubric:` artifacts remain readable for in-flight and persisted runs. Runtime
consumers classify them as legacy:

- legacy `prerequisites` continue to act as verification;
- legacy `tier: contract` factors retain pass/fail review meaning;
- legacy `tier: quality` factors retain scored review meaning.

New planning artifacts use the structured channels. Do not rewrite an in-flight legacy
artifact merely to change its schema.
