# Guidance Packs

Compact execution guidance packs are advisory working-style snippets selected by `task_profile.guidance_packs`. They help the executor choose useful habits for the task shape, but Done Criteria, rubric factors, rubric commands, and scope boundaries remain authoritative.

This reference is the pack library. Relay-plan renders the selected `#### Guidance` bullets into dispatch prompts. Persisting pack metadata in run artifacts and reporting pack analytics are separate follow-up work.

## Pack Contract

- Keep pack text compact enough for future dispatch prompt rendering.
- Write behavior guidance, not full skill instructions.
- Use executor-agnostic wording; correctness must not depend on provider-specific skill paths, local tool names, or workflow commands.
- Promote required outcomes into Done Criteria or rubric factors. Guidance can suggest how to work, but it cannot define pass/fail by itself.

## Initial Pack Library

### `surgical-change`

#### Use when

- Source, prompt, test, or reference changes are expected.
- The task is S/M size and scope creep is a primary risk.

#### Do not use when

- The task intentionally asks for broad redesign, migration, or exploratory cleanup.
- Correctness depends on a larger coordinated refactor already captured in Done Criteria.

#### Guidance

- Keep the diff narrow and trace each changed line to Done Criteria, rubric factors, or cleanup caused by this task.
- Prefer existing local patterns before adding new abstractions.
- Avoid adjacent refactors unless the task change made them necessary.

#### Rubric still carries

- Required behavior, compatibility, public surface, and scope boundaries must remain in Done Criteria or rubric factors. This pack is advisory and does not override them.

### `verification-evidence`

#### Use when

- The executor changes files, commits work, or must leave reviewable proof.
- The reviewer needs exact artifacts, commands, or outcomes to evaluate the run.

#### Do not use when

- The task is read-only analysis with no changed artifacts or runnable checks.
- Evidence requirements are already fully specified as rubric factors and no extra completion note is useful.

#### Guidance

- Record changed artifacts, exact checks run, pass/fail results, and known blockers before completion.
- Treat tests, manifests, logs, and self-reports as evidence signals, not proof by themselves.
- If a required factor remains failing after focused attempts, stop with a concrete stuck note.

#### Rubric still carries

- Required commands, targets, failure thresholds, and evidence fields must remain in Done Criteria or rubric factors. This pack is advisory and cannot replace automated checks.

### `user-replay-evidence`

#### Use when

- User-visible product flows, user journeys, onboarding, checkout, or similar screen-by-screen paths change.
- A reviewer benefits from concise replay notes showing what a user can now do.

#### Do not use when

- The work is generic backend, docs, tests, prompt, or infrastructure with no changed product journey.
- Replay requirements are already explicit pass/fail items in Done Criteria or rubric factors.

#### Guidance

- Leave concise replay evidence: entry point, main user path, final state, and any visible edge case checked.
- Prefer concrete observations over broad claims about product quality.
- Do not create new pass/fail requirements unless they already live in Done Criteria or rubric factors.

#### Rubric still carries

- Required journeys, target states, evidence format, browser/device coverage, and failure thresholds must remain in Done Criteria or rubric factors. This pack is advisory replay guidance only.

### `simplify-pass`

#### Use when

- M+ code, refactor, parsing, prompt rendering, state handling, or helper extraction is involved.
- Historical or task-specific signal suggests quality factors may take extra rounds.

#### Do not use when

- The task is a tiny mechanical edit where a second cleanup pass would add churn.
- The requested change is intentionally a compatibility shim or temporary bridge.

#### Guidance

- After green checks, review only files changed by this task.
- Preserve behavior exactly while removing unnecessary branching, duplication, and single-use abstractions.
- Prefer explicit readable code over dense clever code.

#### Rubric still carries

- Behavior preservation, public API compatibility, performance constraints, and changed-file scope must remain in Done Criteria or rubric factors. This pack is advisory cleanup guidance only.

### `docs-reader-success`

#### Use when

- Documentation, README, operator guide, skill text, or reference material changes are expected.
- A reader should be able to act with no conversation context.

#### Do not use when

- The work is primarily implementation and docs are only incidental release notes.
- Reader outcomes cannot be evaluated without product decisions outside the task.

#### Guidance

- Verify referenced files, flags, commands, and issue numbers when practical.
- Make examples runnable or clearly mark them as illustrative.
- Explain enough context for the intended reader to choose the next action.

#### Rubric still carries

- Required doc artifacts, link or command checks, terminology, and reader outcomes must remain in Done Criteria or rubric factors. This pack is advisory and not a doc acceptance test.

### `trust-boundary`

#### Use when

- The task touches manifest validation, state transitions, review gates, auth boundaries, trust roots, or fail-closed behavior.
- Forged, missing, stale, or mismatched inputs could change a protected decision.

#### Do not use when

- The task only uses generic validation language for docs, formatting, or non-security input cleanup.
- Security posture is unaffected and trust assumptions stay unchanged.

#### Guidance

- Name the trust root and the protected decision.
- Distinguish visible warnings from fail-closed enforcement.
- Test forged, missing, stale, or mismatched inputs where practical.

#### Rubric still carries

- Trust root, enforcement layer, bypass cases, fail-closed behavior, and regression coverage must remain in Done Criteria or rubric factors. This pack is advisory and pairs with `references/rubric-trust-model.md`.
