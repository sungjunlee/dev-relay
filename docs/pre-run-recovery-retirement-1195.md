# Pre-run recovery retirement evidence (#1195)

Measured 2026-08-09 against the production scripts and the post-`worktree add`,
pre-`run.json` kill test.

Generated filesystem inventory: relay-dispatch runtime 6,941→6,238 LOC (−703),
Relay tests 14,675→14,009 LOC (−666), and registration sites 555→539.

| Option | Interface size | Failure recovery | Data-loss boundary | Decision |
| --- | ---: | --- | --- | --- |
| Keep automatic pre-run cleanup | 699 lines in `recover.js` plus 22 CLI lines and a second branch selector | Removes a narrow class of clean pairs, with extensive quarantine/rollback machinery | Relay still cannot prove that Git state without `run.json` is Relay-owned | Reject |
| Reorder `run.json` before worktree creation | Adds an incomplete lifecycle state or a second intent/phase contract | Makes the kill window run-addressable | A record would claim a worktree that may never have existed; valid-run recovery semantics widen | Reject |
| Remove automatic pre-run cleanup | Removes the separate branch route and 699 production lines | Caught creation failures still unwind their own pair; an uncatchable post-add kill preserves the pair and a retry returns typed `BRANCH_EXISTS` | Preserves state whose ownership Relay cannot authenticate | Select |

The selected contract keeps immutable `run.json` as the lifecycle boundary. Valid-run
inspect/recover remains unchanged and `recover` remains its sole general lifecycle
writer. No intent, phase, incomplete run, dispatch-side recovery, or second writer was
introduced.

Operators can inspect retained Git registrations with:

```bash
git worktree list --porcelain
```

Relay does not automatically delete a pre-run branch/worktree pair and does not infer
that an existing branch is stranded. The safe default is preservation or choosing a
new branch and run.
