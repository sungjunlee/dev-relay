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

## Completion Responsibilities

Choose the implementation, exploration, test, and repair sequence that best fits the task.

  0. PREREQUISITE GATE: Run required prerequisite checks as the final gate. Do not modify automated check commands merely to make them pass.
- Implement every Done Criteria outcome within the stated scope boundaries.
- Run relevant verification and fix failures found.
- Capture concise verification evidence expected by the run: commands and result summaries plus concrete artifact references for the Done Criteria.
- Leave a concrete stuck note with partial evidence if completion is impossible.
- Completion requires both the captured evidence and confirmation that the final work is committed.
