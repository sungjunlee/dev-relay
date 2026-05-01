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
  0. PREREQUISITE GATE: Run prerequisite checks. Any fails → fix before scoring factors.
  1. Run automated factors and self-evaluate evaluated factors. Record evidence in the Score Log.
  2. Fix the weakest required failing factor with one focused change. Do not modify rubric commands to make them pass.
  3. Re-run affected checks plus any previously passing factor that could regress.
  4. Stop only when all required factors meet target, self-review finds no stubs/TODOs/test shortcuts, and the final work is committed.
  5. If the same required factor is still failing after 3 focused attempts, stop with partial progress, evidence, and a clear stuck note.
```
