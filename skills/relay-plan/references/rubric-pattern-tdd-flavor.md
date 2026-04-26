# Rubric Pattern — TDD Factor Flavor

Use this pattern when one rubric factor should prove red-first work without turning the whole rubric into a TDD task.

## Field presence

Add `tdd_anchor: <path-string>` only to factors that need a red-first test. The field's presence is the opt-in signal.

Do not add a top-level `tdd_mode`. Non-TDD factors in the same rubric stay under the normal iteration and review rules.

## Runner resolution

Add `tdd_runner: <jest|pytest|mocha|vitest|...>` when the runner is clear. If it is omitted, the executor uses the first `test_infra` entry from `probe-executor-env.js --project-only --json`.

If no runner is available from either source, dispatch must stop before Step 0a with a clear error.

## Prerequisite exclusion

During Step 0a only, run each `rubric.prerequisites[].command` with the framework-native path-exclusion flag for every `tdd_anchor` path.

Do not modify `rubric.factors[].command`. If a prerequisite command has no native exclusion flag, stop instead of running it unfiltered or skipping it.

## Review relaxation

Reviewers may treat a non-HEAD commit whose subject starts with `tdd: red — ` as protocol evidence when HEAD resolves the introduced failures.

This relaxation applies only to factors carrying `tdd_anchor`. Outcome checks, quality checks, and non-TDD factors in the same rubric are reviewed normally.

**Worked example: parser validation**

```yaml
rubric:
  prerequisites:
    - command: "node --test"
      target: "exit 0"
  factors:
    - name: Parser rejects malformed front matter
      tier: contract
      type: automated
      command: "node --test tests/parser-frontmatter.test.js"
      target: "exit 0"
      weight: required
      tdd_anchor: "tests/parser-frontmatter.test.js"
      tdd_runner: "node:test"
    - name: Error message clarity
      tier: quality
      type: evaluated
      criteria: "Errors name the invalid key and the expected shape."
      target: ">= 8/10"
      weight: required
      scoring_guide:
        low: "Generic parse failure only."
        mid: "Names the invalid key but not the expected shape."
        high: "Names the invalid key, expected shape, and caller action."
```

Concrete checks:

- Field presence: only the parser contract factor carries `tdd_anchor`.
- Runner resolution: `tdd_runner` names the targeted test framework.
- Prerequisite exclusion: Step 0a excludes `tests/parser-frontmatter.test.js` from prerequisite commands only.
- Review relaxation: the red commit helps the parser contract factor only; `Error message clarity` is still reviewed under the normal quality standard.

## Why the rubric uses per-factor `tdd_anchor` and not a top-level `tdd_mode`

This pattern rejected the original #142 issue body's `tdd_mode: boolean` field in favor of per-factor `tdd_anchor` opt-in. Reasons:

- A top-level `tdd_mode: true` paired with zero factor-level `tdd_anchor` creates an architecturally impossible failure mode that requires a validator. Per `feedback_rubric_unreachable_path_clauses.md`, do not prescribe fallback for impossible states. Dropping `tdd_mode` deletes both the failure mode and the validator.
- Per-factor opt-in matches the reality that within one rubric some factors are TDD-appropriate (algorithmic, crisp specs) and others are not (text/docs/conventions/UI).
- The verdict-side strict-mode invariant test (PR #304 / #301) stays trivially green because the verdict schema is untouched.

The deviation is recorded under `done_criteria_source: planner_decision` in the persisted Done Criteria anchor at `~/.relay/runs/<repo-slug>/<run-id>/done-criteria.md`.

## Out of scope

- Top-level `tdd_mode: boolean` field (this pattern's primary deviation from #142's issue body).
- TDD auto-suggestion (#145) — planner choosing `tdd_anchor` based on probe signals.
- Adding `tdd_anchor`, `tdd_runner`, or any TDD-related field to the verdict schema.
- Per-commit CI gating; dev-relay reviews HEAD diff, not per-commit.
- Multiple `tdd: red — ` commits (one per factor); a single combined commit covers all anchors.
- Generalization to a "factor flavor" framework with multiple flavors (TDD + walking-skeleton + property-based + …); rule of three — generalize when a third flavor appears, not before.

## See also

- `skills/relay-plan/references/rubric-design-guide.md` — overall rubric design guidance and tier classification.
- `skills/relay-review/references/reviewer-prompt.md` § "TDD factor flavor" — reviewer-side regex gating and relaxation scope.
