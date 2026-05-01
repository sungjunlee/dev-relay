# Iteration Protocol

The compact measure-fix-verify loop that every dispatch prompt must include. Take the base template at `../../relay/references/prompt-template.md` and append the sections listed in `SKILL.md` § 10. Keep the default protocol short; detailed lock/stuck mechanics belong in planner notes or L/XL task guidance, not every executor prompt.

## Optional TDD Factor Flavor

`tdd_anchor: <path-string>` is an optional per-factor field. Its presence is the opt-in signal for that factor. Do not add a top-level `tdd_mode` field.

`tdd_runner: <jest|pytest|mocha|vitest|...>` is an optional per-factor companion. When a factor has `tdd_anchor` and omits `tdd_runner`, resolve the runner from the first `test_infra` entry reported by:

```bash
node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json
```

If the probe reports zero `test_infra` entries and `tdd_runner` is omitted on a factor with `tdd_anchor`, stop before Step 0a with a clear error.

| any factor has `tdd_anchor` | Behavior |
|------|----------|
| Yes  | Step 0a active for every anchor; reviewer TDD section active; prereq exclusion active for those paths; final self-review shortcut check relaxed for `tdd_anchor` factors only |
| No   | Compact default protocol; reviewer prompt unchanged |

Optional Step 0a block to insert before Step 0 only when any factor carries a non-empty `tdd_anchor`:

```
  0a. TDD RED ANCHOR STEP:
     a) Write failing test(s) targeting every factor's `tdd_anchor`, grouped into a SINGLE commit covering all anchors.
     b) The commit subject MUST start with the literal prefix `tdd: red — ` (lowercase `tdd`, lowercase `red`, em-dash U+2014 surrounded by single spaces).
     c) Run every `rubric.prerequisites[].command` with the executor's framework-native exclusion flag for every `tdd_anchor` path. Assert exit 0 on each.
        If any prerequisite command does not support such a path-exclusion flag, surface a stuck signal at the start of Step 0a and STOP.
        Do not modify `rubric.factors[].command`; the exclusion applies only to Step 0a prerequisite commands.
     d) Run the test command resolved from `tdd_runner` on the `tdd_anchor` paths and assert NON-zero exit. Red verified.
     e) Proceed to Step 0 and the rest of the loop.
```

When Step 0a is active, also append this sentence under the final self-review step: "For factors carrying `tdd_anchor`, a red test commit that is green at HEAD is not a shortcut by itself; this relaxation applies only to factors carrying `tdd_anchor`; other factors in the same rubric are reviewed under the existing rule."

## Iteration Protocol (compact default)

```
BEFORE LOOP: Run baseline if defined. RULE: Do NOT modify automated check commands.
LOOP (max 5 iterations):
  0. PREREQUISITE GATE: Run prerequisite checks. Any fails → fix before scoring factors.
  1. Run automated factors and self-evaluate evaluated factors. Record evidence in the Score Log. Use 0-10 numbers for quality factors with numeric targets.
  2. Fix the weakest required failing factor with one focused change. For below-target quality scores, optimize the lowest reviewer score without changing rubric commands.
  3. Re-run affected checks plus any previously passing factor that could regress.
  4. Stop only when all required factors meet target, self-review finds no stubs/TODOs/test shortcuts, and the final work is committed.
  5. If the same required factor is still failing after 3 focused attempts, stop with partial progress, evidence, and a clear stuck note.
```

## Score Log

Executor appends one row per iteration to the PR description. Reviewer re-scores independently. The runner stores reviewer numeric scores as first-class event data when available, then uses score trend to target re-dispatch.

```
| Factor | Target | Baseline | Iter 1 | Iter 2 | Final | Status |
|--------|--------|----------|--------|--------|-------|--------|
```

Status: `—` (not met), `pass`, `fail`, or `blocked`.

Quality scores are optimization signals inside the normal review gate. Contract factors remain binary; quality factors can converge from `6/10 → 7.5/10 → 8/10` without adding new manifest states.

For L/XL tasks with interfering factors, the planner may add stricter lock/oscillation guidance to the dispatch prompt. Do not add that machinery to S/M prompts by default.
