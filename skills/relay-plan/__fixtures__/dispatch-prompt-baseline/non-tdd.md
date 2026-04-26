# Dispatch

Implement the documented behavior.

## Scoring Rubric

```yaml
rubric:
  prerequisites:
    - command: "node --test"
      target: "exit 0"
  factors:
    - name: Behavior remains stable
      tier: contract
      type: automated
      command: "node --test tests/behavior.test.js"
      target: "exit 0"
      weight: required
```

## Iteration Protocol

```
BEFORE LOOP: Run baseline if defined. RULE: Do NOT modify automated check commands.
LOOP (max 5 iterations):
  0. PREREQUISITE GATE: Run all prerequisite checks. Any fails → fix before proceeding.
  1. Run ALL automated checks + self-evaluate ALL evaluated factors, record scores
  2. REGRESSION CHECK: Any factor previously marked locked now below target?
     → Revert this iteration's changes (git reset to previous commit)
     → Re-attempt with constraint: "Maintain [factor] at [score] while improving [target factor]"
     → Regression persists after 1 re-attempt → flag both factors, escalate
  3. Append to Score Log — mark factors that meet target as locked
  4. All required meet target → adversarial self-review:
     - Review as if you did NOT write this code and are seeing it for the first time
     - For each automated check: could the target be met by a shortcut that misses the intent?
     - For each evaluated factor: re-read scoring_guide "high" — does it genuinely apply?
     - Check: stubs, TODOs, hardcoded values, test manipulation, placeholder returns
     → All clear → PR
     → Issues found → fix → re-score → PR
  5. Else → lowest required factor → if fix_hint exists, apply it as the starting fix → ONE focused change → commit → repeat
  6. Stuck detection: same factor below target for 3 consecutive iterations → stop, create PR with partial progress
```
