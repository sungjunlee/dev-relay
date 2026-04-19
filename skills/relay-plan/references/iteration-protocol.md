# Iteration Protocol

The measure-fix-keep loop that every dispatch prompt must include. Take the base template at `../../relay/references/prompt-template.md` and append the sections listed in `SKILL.md` § 4 — this file holds the full text of the iteration loop and the Score Log table format.

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
