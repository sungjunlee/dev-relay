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
- fails fast for `policy.review_assurance=hardened` unless `--advisory-reviewer <name>` is present, except in `--prepare-only` mode
- computes and overrides `quality_execution_status` from `execution-evidence.json`; strict gates prefer `verification_runs[]` when present and otherwise use the legacy `test_*` fields
- rejects the round if the reviewer mutates the repo and escalates the manifest
- writes the PR audit comment
- updates the relay manifest to `ready_to_merge`, `changes_requested`, or `escalated`

Reviewer adapter capabilities are shared with dispatch adapter metadata. See `../../relay-dispatch/references/agent-adapter-platform.md` for the supported adapter matrix, including primary vs advisory review support, read-only enforcement, structured-output shape, and the new-adapter checklist. Antigravity review support is for the `agy` CLI only, not GUI/IDE/Desktop flows.

## Codex-only Operation Regression

Codex-only operation is covered as a regression for `policy.review_assurance=hardened`, not a Codex-only policy special case. When `roles.orchestrator`, `roles.executor`, and `roles.reviewer` are all `codex`, the runner still follows the same manifest policy contract used by any other role names. Advisory evidence is required for passing hardened rounds, advisory required findings block the pass, and strict execution evidence must bind to the reviewed head.

## Independent Review Attempts

Escalated runs may be reopened for one independent review attempt. A different `--reviewer` records a `reviewer_swap` event with `reason=different_reviewer:<from>-><to>`. Reusing the same adapter requires `--independent-review-reason <text>` so the audit trail explains how the attempt is independent, such as a fresh ephemeral context, different model hint, or materially different prompt bundle.

## Backward Compatibility

Pre-261 runs do not have `execution-evidence.json`. In that case the runner computes `quality_execution_status=missing`, a reviewer PASS cannot be applied, and operators should use `finalize-run --force-finalize-nonready --reason "pre-261 run, no artifact"` only after independent verification.
