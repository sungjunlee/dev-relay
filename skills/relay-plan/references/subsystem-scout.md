# Optional Subsystem Scout

The subsystem scout is an optional read-only planning aid for L/XL or high-ambiguity tasks. It belongs in `relay-plan` as a risk-triggered add-on, not in the existing `relay-sidecar` runner. Existing `relay-sidecar` artifacts are for an already-created relay run and PR/diff context; the scout runs before Done Criteria are frozen and must not create a new lifecycle state.

## Trigger criteria

Run a scout only when at least one condition applies:

- Task size is L or XL and the likely subsystem boundary is unclear.
- The task spans multiple packages, skills, state machines, trust boundaries, or public surfaces.
- The issue asks for planning, architecture, migration, or ambiguous behavioral design before implementation.
- A planner cannot name likely files, tests, and review risks without broad code search.

Skip the scout when:

- The task is S/M with clear target files or an existing relay-ready handoff.
- The task is documentation-only and the target docs are named.
- Existing probe/historical/harness signals already identify the right commands and directories.
- Running the scout would only duplicate Done Criteria recovery or rubric design.

## Output shape

A scout artifact should be concise and artifact-only:

```md
# Subsystem Scout

## Relevant files and directories
- `path`: why it matters

## Existing tests and commands
- command or test path: why it is relevant

## Harness context read
- `AGENTS.md`: relevant boundary or instruction

## Risk areas
- risk: why it may affect Done Criteria or rubric factors

## Recommended planning anchor
One sentence naming the best starting anchor for Done Criteria recovery.
```

## Consumption boundary

The scout is a weak planning signal. It may help the planner decide where to look, which commands to consider, and which risks deserve questions. It does not supply acceptance criteria, freeze Done Criteria, select rubric factors automatically, gate dispatch, or alter relay manifest state.

When the scout reveals a requirement not present in the task source, treat it as an ambiguity or inferred Done Criteria candidate. Resolve the conflict before freezing the review anchor, then persist planner-authored Done Criteria if the final anchor differs from the issue body or relay-ready handoff.

## Storage

Until a dedicated runner exists, keep scout output as planner-local handoff material such as `/tmp/relay-scout-<issue-or-run>.md` or inline planning notes. Do not write scout artifacts into `~/.relay/runs/` before dispatch allocates a run. If a future runner is added, it should preserve the same read-only, non-authoritative contract and test both the skip path and artifact path.
