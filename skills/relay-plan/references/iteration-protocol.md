# Iteration Protocol

The measure-fix-keep loop that every dispatch prompt must include. Take the base template at `../../relay/references/prompt-template.md` and append the sections listed in `SKILL.md` § 4 — this file holds the full text of the iteration loop and the Score Log table format.

## Optional TDD Factor Flavor

`tdd_anchor: <path-string>` is an optional per-factor field. Its presence is the opt-in signal for that factor. Do not add a top-level `tdd_mode` field.

`tdd_runner: <jest|pytest|mocha|vitest|...>` is an optional per-factor companion. When a factor has `tdd_anchor` and omits `tdd_runner`, resolve the runner from the first `test_infra` entry reported by:

```bash
node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json
```

If the probe reports zero `test_infra` entries and `tdd_runner` is omitted on a factor with `tdd_anchor`, stop before Step 0a with a clear error.

| any factor has `tdd_anchor` | Behavior |
|------|----------|
| Yes  | Step 0a active for every anchor; reviewer TDD section active; prereq exclusion active for those paths; Step 4(a) relaxed for `tdd_anchor` factors only |
| No   | Pre-#142 baseline; byte-identical prompts; reviewer prompt unchanged |

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

When Step 0a is active, also append this sentence under Step 4(a): "For factors carrying `tdd_anchor`, a red test commit that is green at HEAD is not a shortcut by itself; this relaxation applies only to factors carrying `tdd_anchor`; other factors in the same rubric are reviewed under the existing rule."

## Iteration Protocol (autoloop-style measure-fix-keep)

```
BEFORE LOOP: Run baseline if defined. RULE: Do NOT modify automated check commands.
LOOP (max 5 iterations):
  0. PREREQUISITE GATE: Run all prerequisite checks. Any fails → fix before proceeding. Prerequisites are not scored, just pass/fail.
  1. Run ALL automated checks + self-evaluate ALL evaluated factors, record scores
  2. REGRESSION CHECK: Any factor previously marked locked now below target?
     → Revert this iteration's changes (git reset to previous commit)
     → Re-attempt with constraint: "Maintain [factor] at [score] while improving [target factor]"
     → Regression persists after 1 re-attempt → flag both factors, escalate
  3. Append to Score Log — mark factors that meet target as locked
  4. All required meet target → adversarial self-review:
     - Review as if you did NOT write this code and are seeing it for the first time
     - For each automated check: could the target be met by a shortcut that misses the intent?
       (e.g., stubbed endpoint returns fast but does nothing; test modified to always pass)
     - For each evaluated factor: re-read scoring_guide "high" — does it genuinely apply?
     - Check: stubs, TODOs, hardcoded values, test manipulation, placeholder returns
     → All clear → PR
     → Issues found → fix → re-score → PR
  5. Else → lowest required factor → if fix_hint exists, apply it as the starting fix → ONE focused change → commit → repeat
  6. Stuck detection (any trigger → best-effort: note in PR, continue | required: stop, create PR with partial progress):
     a) Single-factor stall: same factor below target for 3 consecutive iterations
     b) Oscillation: any two factors alternate regression across 4+ iterations
     c) Plateau: no required factor improved toward target over 2 consecutive iterations
```

## Score Log

Executor appends one row per iteration to the PR description. Reviewer re-scores independently.

```
| Factor | Target | Baseline | Iter 1 | Iter 2 | Final | Status |
|--------|--------|----------|--------|--------|-------|--------|
```

Status: `—` (not met), `locked` (met target — must not regress in subsequent iterations).
