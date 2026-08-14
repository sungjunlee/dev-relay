# Execution Contract

This compatibility-named reference defines the compact completion responsibilities that every dispatch prompt includes. Take the base template at `../../relay/references/prompt-template.md` and append the sections named in the Default Path of `SKILL.md`: Setup, optional Working Guidance, Evaluation Channels, and Completion Responsibilities. Relay specifies observable completion, not the executor's internal iteration strategy.

## Optional TDD Factor Flavor

`tdd_anchor: <path-string>` is an optional per-factor field. Its presence is the opt-in signal for that factor. Do not add a top-level `tdd_mode` field.

`tdd_runner: <jest|pytest|mocha|vitest|...>` is an optional per-factor companion. When a factor has `tdd_anchor` and omits `tdd_runner`, resolve the runner from the first `test_infra` entry reported by:

```bash
node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json
```

If that probe reports zero `test_infra` entries, fall back to the first `project_tools.frameworks` entry whose name is a known test framework (`jest`, `pytest`, `mocha`, `vitest`, `node:test`, `playwright`, `@playwright/test`).

If neither source yields a runner for a factor that carries `tdd_anchor` and omits `tdd_runner`, stop before Step 0a with a clear error naming that factor. One unresolved factor stops the whole Step 0a block: no anchor runs under a guessed runner.

| any factor has `tdd_anchor` | Behavior |
|------|----------|
| Yes  | Step 0a active for every anchor; reviewer TDD section active; prerequisite exclusion active for those paths |
| No   | Compact default completion contract; reviewer prompt unchanged |

Optional Step 0a block to insert before the prerequisite gate only when any factor carries a non-empty `tdd_anchor`:

```
  0a. TDD RED ANCHOR STEP:
     Active anchors: `<tdd_anchor>` via `<resolved tdd_runner>`, one entry per factor carrying a non-empty `tdd_anchor`.
     a) Write failing test(s) targeting every factor's `tdd_anchor`, grouped into a SINGLE commit covering all anchors.
     b) The commit subject MUST start with the literal prefix `tdd: red — ` (lowercase `tdd`, lowercase `red`, em-dash U+2014 surrounded by single spaces).
     c) Run every `rubric.prerequisites[].command` with the executor's framework-native exclusion flag for every `tdd_anchor` path. Assert exit 0 on each.
        If any prerequisite command does not support such a path-exclusion flag, surface a stuck signal at the start of Step 0a and STOP.
        Do not modify `rubric.factors[].command`; the exclusion applies only to Step 0a prerequisite commands.
     d) Run the test command resolved from `tdd_runner` on the `tdd_anchor` paths and assert NON-zero exit. Red verified.
     e) Proceed to the prerequisite gate and remaining completion responsibilities.
```

## Completion Responsibilities

Choose the implementation, exploration, test, and repair sequence that best fits the task.

  0. PREREQUISITE GATE: Treat prerequisite checks as the final gate, not a per-iteration check. Run targeted or touched suites as useful during implementation, then run long repo-wide prerequisites once before handoff. Any final prerequisite failure must be fixed before completion. Do not modify automated check commands merely to make them pass.
- Implement every Done Criteria outcome within the stated scope boundaries.
- Run relevant verification and fix failures found.
- Capture concise verification evidence expected by the run: commands and result summaries plus concrete artifact references for the Done Criteria.
- Leave a concrete stuck note with partial evidence if completion is impossible.
- Completion requires both the captured evidence and reviewable dirty-worktree changes.
