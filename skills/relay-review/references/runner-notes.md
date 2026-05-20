# Review Runner Notes

Operational details for `scripts/review-runner.js`.

## Resolution and Anchors

`review-runner.js` keeps file-backed Done Criteria strongest:

1. `--done-criteria-file`
2. `anchor.done_criteria_path`
3. issue loading

When it must infer a GitHub issue, it tries:

1. `manifest.issue.number`
2. explicit PR-body closing keywords (`Fix/Fixes`, `Close/Closes`, `Resolve/Resolves`)
3. branch `issue-N`
4. a single `closingIssuesReferences` entry

It ignores `Refs`, `Related`, and incidental issue prose. Multiple inferred closing refs fail instead of silently selecting one.

Rubric resolution is run-dir-native. `review-runner.js` calls `loadRubricFromRunDir(runDir, data)`, which resolves `anchor.rubric_path` relative to the run directory and reads the rubric directly from there. Reviewers must not copy `rubric.yaml` or any other run artifact into the worktree; if `rubricStatus` looks unsatisfied, investigate run-directory path resolution instead of working around it with a worktree copy.

## Generated Artifacts

Prepared or invoked rounds write artifacts under `~/.relay/runs/<repo-slug>/<run-id>/`:

- `review-round-N-prompt.md`
- `review-round-N-done-criteria.md`
- `review-round-N-diff.patch`
- `review-round-N-verdict.json`
- `review-round-N-raw-response.txt` when the runner invoked the reviewer
- `review-round-N-policy-violation.txt` if the reviewer changed files
- `review-round-N-redispatch.md` when changes are requested

The runner reviews the retained checkout recorded in `paths.worktree`, not the repo root. It records `review.last_reviewed_sha`, enforces `review.max_rounds`, and escalates when the same issue fingerprint repeats 3 consecutive rounds.

## Audit Trail

When applying a verdict, the runner:

- validates the JSON verdict
- optionally invokes the reviewer adapter itself when `--reviewer <name>` is used
- computes and overrides `quality_execution_status` from `execution-evidence.json`
- rejects the round if the reviewer mutates the repo and escalates the manifest
- writes the PR audit comment
- updates the relay manifest to `ready_to_merge`, `changes_requested`, or `escalated`

## Backward Compatibility

Pre-261 runs do not have `execution-evidence.json`. In that case the runner computes `quality_execution_status=missing`, a reviewer PASS cannot be applied, and operators should use `finalize-run --force-finalize-nonready --reason "pre-261 run, no artifact"` only after independent verification.
