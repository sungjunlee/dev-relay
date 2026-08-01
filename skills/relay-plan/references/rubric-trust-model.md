# Rubric trust-model audit

Use this reference when a task changes an authorization boundary, trust root,
external observation, immutable record, or merge gate. A schema-only factor is
not enough when a plausible but forged value could pass.

## Three required questions

### 1. Who can forge the claim?

Assume a confused or malicious executor can write its retained worktree and
ordinary files inside the run directory, but cannot mint runtime lock
capabilities or fresh external-observer capabilities. State whether that actor
can manufacture the claim being accepted.

If yes, add a distinct authentication factor. Do not hide it as one bullet in a
general validation factor.

### 2. Where is the exact gate?

Name the current `file:function` that rejects the claim. Typical vNext sites are:

- `skills/relay-dispatch/scripts/run-store.js:readRunRecord` for immutable run
  identity and frozen Done Criteria;
- `skills/relay-dispatch/scripts/recover.js:inspectProductionRun` for fact-derived
  lifecycle decisions;
- `skills/relay-review/scripts/review-runner.js:requireReviewAction` for the
  exact PR head and Done Criteria review binding;
- `skills/relay-merge/scripts/review-gate.js:requireMergeAction` for the exact
  merge authorization boundary.

Prompt text is not a gate. It may be a useful visible warning, but the factor
must identify the code path that fails closed.

### 3. What independently verifies it?

Name the independent source used at the gate: immutable source bytes, a durable
fact emitted under a run lock, a fresh GitHub observation capability, a Git
object identity, or a verified filesystem property. A field proving another
field in the same caller-controlled object is self-attestation, not
verification.

## Factor shape

```yaml
- name: exact_gate_rejects_forged_claim
  tier: contract
  type: evaluated
  criteria: |
    - `<file:function>` compares the durable claim with `<independent source>`.
    - A plausible forged value fails with an explicit blocker.
    - The accepted value is bound to the exact run/head/criteria identity.
  target: strong

- name: forged_claim_regression
  tier: contract
  type: automated
  command: "<focused black-box test command>"
  target: "exit 0"
```

## PR audit

```markdown
### Trust-model audit

- **Q1 (forge)**: [yes/no and why] — factor: `<factor-name>`
- **Q2 (gate)**: [`file:function`] — factor: `<factor-name>`
- **Q3 (independent verifier)**: [fact/artifact/property] — factor: `<factor-name>`
```

Leaving any triggered question unanswered is a rubric-design failure.

## Related

- `references/rubric-domain-axes.md#rubric--security`
- `references/rubric-fail-closed-patterns.md`
