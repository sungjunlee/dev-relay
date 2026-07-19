# Risk-Adaptive Relay Simplification

**Status:** Approved
**Date:** 2026-07-19

## Context

Coding models increasingly sustain long-running implementation, tool use, recovery, and
validation with less procedural supervision. Relay should evolve with that capability
without weakening the boundaries that make delegation safe.

The current workflow mixes several different concerns inside a mandatory rubric and a
detailed executor protocol:

- the task contract;
- repository hygiene checks;
- quality optimization;
- executor self-review;
- independent review;
- lifecycle and merge safety.

This creates pressure to fill every task with generic factors such as tests passing,
files existing, or broad code-quality scores. It can also steer strong models toward
compliance with the harness rather than toward the best outcome.

The design direction is progressive subtraction: preserve a small set of durable
boundaries, delegate more cognitive work to the model, and delete procedural machinery
only after a lighter path proves equivalent or better on real work.

## Design Goal

Relay should enforce boundaries centrally and allow substantial model autonomy within
those boundaries.

It should preserve:

1. user intent and scope;
2. permission boundaries;
3. execution isolation;
4. observable outcome verification;
5. accountable execution history;
6. explicit approval for irreversible actions.

Everything else is a replaceable policy, including rubric shape, score scales, review
count, prompt steps, route selection rules, and lifecycle detail.

## Non-Goals

- Removing independent review from every workflow.
- Treating stronger model identity as evidence that a risky action is safe.
- Replacing outcome evidence with model self-report.
- Rewriting the state machine before workflow simplification is proven.
- Forcing every task to produce scored quality factors.
- Removing scored optimization when a task contains a genuine quality gradient.

## Chosen Transition Strategy

Use a gradual subtraction path.

The existing hardened path remains available while a lighter path is introduced and
measured. Low-risk work adopts the lighter path first. Medium-risk work follows after
evidence accumulates. High-risk work remains hardened until the end of the observation
window.

This temporarily preserves two behavior profiles, but it keeps the transition
reversible and makes it possible to distinguish useful safeguards from inherited
process.

## Target Flow

```text
request
  -> outcome contract
  -> risk judgment
  -> observation of the real evaluation surface
  -> earned rubric or no rubric
  -> autonomous implementation
  -> mechanical verification
  -> independent review
  -> ready_to_merge
```

### Planning Output

Planning produces four conceptually separate outputs:

1. **Outcome Contract**: observable outcomes and explicit non-goals.
2. **Risk**: impact, reversibility, authority, and affected trust boundaries.
3. **Verification**: executable or observable evidence of completion.
4. **Earned Rubric**: optional quality dimensions grounded in the task and its real
   evaluation surface.

No earned rubric is a valid planning result.

### Dispatch Input

The executor receives:

- the goal;
- non-negotiable scope boundaries;
- available environment and tools;
- observable completion evidence;
- optional earned quality dimensions.

The executor chooses the implementation approach, exploration order, test order, and
repair loop.

## Remove the Executor Self-Review Protocol

Relay should stop requiring a separate executor self-review ceremony.

Remove:

- executor-authored quality scores;
- per-iteration Score Logs;
- baseline-to-iteration score tables;
- fixed iteration counts;
- weakest-factor optimization instructions;
- generic self-review checklists.

The executor still implements the requested outcome, runs relevant verification, fixes
failures, commits the result, and leaves evidence. These are completion responsibilities,
not a separate review role.

The model remains free to reflect on its own work internally. Relay does not prescribe
or audit that internal process.

## Separate Verification from Quality Evaluation

Repository hygiene and binary contract checks are not scored quality factors.

Typical verification includes:

- tests passing;
- builds completing;
- type checking;
- required artifacts existing;
- commands exiting successfully;
- a user flow reaching the required state.

Verification may be mandatory, but it does not earn a place in the scored rubric merely
because it is easy to measure.

The runtime should prefer captured command and observation evidence over executor
narrative.

## Earned Rubric

Scored optimization remains valuable when planning can derive a real quality gradient.
It must not be generated to satisfy a schema quota.

A scored factor is earned only when all four conditions hold:

1. **Gradient**: multiple contract-satisfying implementations can differ meaningfully.
2. **Observable**: weak, adequate, and strong results can be distinguished in the
   artifact or its behavior.
3. **Actionable**: a lower assessment gives the executor a meaningful improvement
   direction.
4. **Consequential**: the difference affects users, maintainability, reliability,
   security, operability, or another material outcome.

If a dimension is required but binary, it belongs in the Outcome Contract. If it is
generic, cosmetic, unsupported, or inconsequential, omit it.

Planning may produce zero, one, or several scored factors. There is no minimum based on
task size.

Qualitative anchors are primary. Numeric scores are an optional representation for
comparison, optimization, or analytics. A planner should first describe weak, adequate,
and strong states, then use a number only when the number improves a real decision.

### Scoring Ownership

The executor sees the quality objective and its strong-state anchor but does not
self-score.

The independent reviewer evaluates earned factors after implementation. A below-target
factor may drive a targeted re-dispatch when it represents a material quality gap.

Scoring is especially useful for:

- comparing model and harness configurations;
- comparing multiple candidate implementations;
- tracking a meaningful quality trend;
- optimizing a deliberately soft but important product quality.

## Observation Before Evaluation

Planning should observe the actual evaluation surface before producing quality
dimensions.

The sequence is:

```text
identify the artifact and its user
  -> determine how the result can be observed
  -> inspect relevant current and target behavior
  -> ask how a contract-satisfying result could still fail
  -> identify what a domain expert would notice
  -> retain only consequential quality dimensions
```

Domain references are lens libraries, not factor templates. A lens expands the
planner's questions without requiring a fixed output.

For design work, observation may include rendered screens, hierarchy, discoverability,
interaction feedback, state coverage, responsive behavior, accessibility, and fit with
the product's character. The relevant dimensions must emerge from the actual product
and user journey. A payment flow and an analytics dashboard should not receive the same
generic visual-quality rubric.

The planner should ask:

> What would a real user or domain expert notice that a generic checklist would miss?

Every proposed factor should also answer:

> If this assessment changed, would an implementation or product decision materially
> change?

If not, remove it.

## Review Model

The default low- and medium-risk path uses one independent review after publication:

```text
Outcome Contract
  + actual diff
  + captured verification
  + optional Earned Rubric
  + the same observation surface
  -> pass or concrete blocking findings
```

The reviewer evaluates only earned quality dimensions. It does not add generic scores
to fill a verdict schema.

New material issues discovered during review are returned as concrete findings. They do
not require retroactively expanding the scored rubric.

Pre-publication review, adversarial review, or additional assurance remains available
for high-risk work and for cases where publication itself creates meaningful exposure.

## Risk-Proportional Assurance

Risk comes from the work, not from the model name.

### Low Risk

- isolated and reversible;
- no sensitive authority or external side effect;
- clear observable outcome.

Use the compact contract, mechanical verification, and one independent review.

### Medium Risk

- affects shared code or interfaces;
- remains testable and recoverable;
- has a bounded blast radius.

Use a fixed Outcome Contract, task-specific verification, optional Earned Rubric, and
one independent review with a targeted repair round when needed.

### High Risk

- security, secrets, protected data, migrations, deployment, money, or irreversible
  effects;
- broad or difficult-to-recover impact.

Retain stronger evidence, pre-publication or adversarial review where appropriate, and
explicit approval boundaries.

Model and harness performance evidence may reduce procedural instruction within a tier.
It does not lower the tier's permission or irreversibility boundary.

## Failure Handling

### Autonomous Recovery

Implementation failures inside the isolated workspace remain the executor's
responsibility, including test failures, build errors, file discovery mistakes, and
bounded compatibility fixes.

### Replan

Return to planning or user clarification when:

- the contract has multiple material interpretations;
- the required observation surface is unavailable;
- a proposed rubric is abstract or ungrounded;
- implementation reveals a necessary scope or product decision.

Do not invent evidence or fill rubric factors when observation is missing.

### Immediate Stop

Fail closed on:

- permission boundary violations;
- protected data or secret access outside policy;
- irreversible external changes without approval;
- repository, branch, or SHA mismatch;
- merge or deployment without current verification;
- loss of required audit history.

## Repair and Escalation

The default path should not retain a twenty-round convergence loop.

1. Run one independent review.
2. If it produces a material finding, perform one targeted re-dispatch.
3. Review the corrected result.
4. Escalate repeated substantive disagreement or failure instead of continuing
   mechanical score optimization.

Additional rounds remain an explicit high-risk or experimental policy.

## Progressive Deletion Sequence

1. Remove executor self-review instructions and Score Log requirements while retaining
   lifecycle and review compatibility.
2. Separate verification from scored factors.
3. Remove minimum scored-factor counts and permit no-rubric planning results.
4. Introduce observation-driven Earned Rubric derivation.
5. Apply risk-proportional review depth, starting with low-risk work.
6. Delete dead schemas, states, compatibility fields, and recovery paths only after the
   behavioral transition is proven.

Do not simplify the state machine first. Simplify behavior, observe it, then remove
structural machinery that no longer represents a real decision boundary.

## Evaluation

Judge the lighter path on:

1. **Outcome quality**: the real contract and user-facing surface pass.
2. **Harness friction**: harness-caused stalls, recovery work, and manual intervention.
3. **Review yield**: independent review finds material defects rather than generic
   compliance gaps.
4. **Rubric value**: earned dimensions materially affect implementation or review.

Do not count routine test or build success as rubric value.

Compare the existing and lighter paths across task classes with different observation
surfaces, including code, design, documentation, operations, security, and data changes.
The evaluation set must include tasks where no scored rubric is the correct result.

## Deletion and Rollback Rules

An existing mechanism becomes a deletion candidate when:

- the lighter path preserves outcome quality;
- the mechanism finds no unique material defect;
- its state, recovery, prompt, and operator cost exceed its demonstrated value;
- permission, isolation, verification, audit, and irreversible-action boundaries remain
  intact without it.

Immediately roll back a lighter path on:

- a protected-boundary bypass;
- an external change against the wrong target;
- success recorded without required observation;
- stale work accepted as reviewed work;
- an irreversible action without explicit approval.

Evaluate ordinary quality variance as a trend across runs. Treat a safety-boundary
violation as sufficient evidence on its own.

## Approved Decisions

- Use risk-proportional assurance.
- Preserve the durable safety and accountability boundaries.
- Remove the explicit executor self-review protocol.
- Keep scored optimization only when planning earns it from a real quality gradient.
- Allow no-rubric planning results.
- Separate binary verification from quality scoring.
- Derive evaluation dimensions from observation of the real artifact and user surface.
- Use one independent review by default.
- Simplify behavior before deleting lifecycle structure.
- Roll out progressively and retain a hardened path during calibration.
