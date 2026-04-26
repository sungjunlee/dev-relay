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
