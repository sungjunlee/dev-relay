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

Generated internal and post-publication diffs are read with the shared 16 MiB
`DEFAULT_EXEC_MAX_BUFFER_BYTES` ceiling. The review degradation threshold is
derived from that ceiling (`GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES`, currently
512 KiB), so the subprocess can always return a diff before the guard runs.
Generated diffs above the threshold are replaced by a `--stat` summary and the
list of files whose patches were omitted. The marker, observed byte size, and
threshold are persisted in `review-round-N-diff.patch`. Operator-supplied
`--diff-file` content remains an unguarded, verbatim escape hatch.

The runner reviews the retained checkout recorded in `paths.worktree`, not the repo root. It records `review.last_reviewed_sha`; `review.rounds` remains the total applied-verdict/artifact sequence. Cap accounting is separate under `review.round_budget`: blocking substantive failures consume the threshold referenced by `review.max_rounds` (compact defaults to `1`, standard to `2`, hardened to `3`), while successful protocol verification is recorded by `internal` or `post_publication` phase and is exempt from that threshold. Thus standard assurance can apply one substantive `changes_requested`, verify its corrected internal result, and perform the required post-publication verification even though the last artifact is global round 3. Reviewer invocation failures do not apply a verdict and consume neither axis.

New manifests persist `round_budget.schema_version=1`, its topology and limit source, `consumed.substantive_failures`, and phase-specific protocol/application counts. Legacy manifests without the block resolve through a deterministic conservative bridge; their next applied verdict persists the normalized block. A still-higher `review.max_rounds` remains an explicit experimental policy extension. Repeated-issue, flip-flop, stale-SHA, advisory, and lifecycle gates remain independent and can escalate earlier.

## Audit Trail

When applying a verdict, the runner:

- validates the JSON verdict
- optionally invokes the reviewer adapter itself when `--reviewer <name>` is used
- preflights `execution-evidence.json` before invoking a primary reviewer; missing, stale, invalid, symlinked, or strict-failing evidence exits with JSON status and leaves the manifest in `review_pending`
- fails fast for `policy.review_assurance=hardened` unless `--advisory-reviewer <name>` is present, except in `--prepare-only` mode
- computes and overrides `quality_execution_status` from `execution-evidence.json`; strict gates prefer `verification_runs[]` when present and otherwise use the legacy `test_*` fields
- rejects the round if the reviewer mutates the repo and escalates the manifest
- writes the PR audit comment
- updates the relay manifest to `ready_to_merge`, `changes_requested`, or `escalated`

Reviewer adapter capabilities are shared with dispatch adapter metadata. See `../../relay-dispatch/references/agent-adapter-platform.md` for the supported adapter matrix, including primary vs advisory review support, read-only enforcement, structured-output shape, and the new-adapter checklist. Antigravity review support is for the `agy` CLI only, not GUI/IDE/Desktop flows.

## Advisory Lane Semantics

Advisory review is configured as a list of lanes. Each lane has `reviewer`, optional `model`, `profile`, `trigger`, and `gating`. Profile defaults are part of lane normalization: `blindspot` defaults to `trigger=every_round,gating=false`; `adversarial` defaults to `trigger=on_pass,gating=true`; explicit `trigger` or `gating` values override the profile default. Route planning and review-runner normalization must agree on these defaults.

`every_round` lanes start before the primary reviewer completes and settle against one round-start deadline. `on_pass` lanes start only after the primary verdict plus all `every_round` gates produce a pass-equivalent outcome; they share a fresh settlement deadline for that trigger group. The runner folds advisory outcomes after each trigger group. Non-gating standard lanes record artifacts, warnings, and metrics only. Gating lanes can demote an applied pass when a successful advisory result reports `required_findings`; hardened assurance treats advisory failures, missing advisory evidence, and required findings as gates. Bucket identity is authoritative: an omitted `severity` is accepted only for `duplicate_or_low_confidence` and normalized to `P3` while remaining non-required. Missing `severity` in either actionable bucket is still a schema failure. Adapter-side schema failures emit the stable `advisory_schema_validation_failed` signal plus the pre-validation model response so the runner can durably preserve every attempt before its single bounded retry.

Lane-driven demotion is capped at two demotions per run. A third lane-driven demotion escalates for owner decision instead of feeding another automatic fix loop. When a gating lane demotes because of required findings, the redispatch prompt includes that lane's required findings as actionable fix items. The `advisory_review` event already carries lane identity (`reviewer`, `model`, `profile`, `trigger`, `gating`), and `reliability-report --by-lane` derives per-lane counts from those events plus `review_apply` demotion signals.

Legacy partial advisory overlays such as `{ "model": "..." }` compose onto exactly one inherited lane. They fail closed against a multi-lane inherited list; operators must spell out the full lane list instead of relying on ambiguous merge behavior.

Lane composition is operator/orchestrator judgment, not script policy. Low-risk tasks usually need no lane or one blindspot lane. Security, concurrency, migration, or invariant-heavy tasks can add an adversarial gating lane. Broad changes can use multiple reviewers/models, but scripts do not auto-select lanes based on task risk.

### Cline advisory timeout budget

For `cline` advisory lanes, `executeAdvisoryRequest` exports the lane's effective `timeoutSeconds` into the adapter child as `RELAY_CLINE_REVIEW_TIMEOUT="<timeoutSeconds>s"`. That lane budget supersedes any inherited `RELAY_CLINE_REVIEW_TIMEOUT` in the review-runner process so one number governs both the parent `execFileSync` kill and the adapter's internal `--timeout` (env − 60s headroom). Operator knob: `--advisory-timeout`. Direct (non-advisory) invocations of `invoke-reviewer-cline.js` keep the existing env contract and default (`1800s`).

### Cline prompt-file compatibility transport

Cline JSON mode requires a positional prompt and rejects relay's stdin-only
transport as interactive. Relay therefore writes the complete advisory prompt
to a temporary file under `--cwd` and passes only a short workspace-relative
reference, `@.relay-review-cline-prompt-*/review-prompt.md`. Cline CLI 3.0.47
ignores mentions outside that workspace and tokenizes mentions at whitespace.
This keeps prompt text and NUL bytes out of argv, records
`prompt_file_reference` compatibility evidence, and removes the temporary
directory after success, parse failure, provider failure, or parent timeout.

### Pi provider extension isolation

Pi reviews disable automatic extension discovery so an operator's unrelated
extensions cannot add tools or hooks to the read-only reviewer. When the chosen
model provider itself is supplied by a trusted Pi extension, set
`RELAY_PI_REVIEW_PROVIDER_EXTENSION` to the absolute path of that provider's
entry file. The adapter keeps `--no-extensions` and adds exactly one explicit
`--extension <path>`; relative, missing, and non-file values fail before Pi is
invoked. Treat the extension as executable reviewer infrastructure and pin or
audit it with the same care as the Pi binary.

## External Review Triggers

Delayed-publication runs should spend external review quota only after the internal relay review has converged:

1. While the run is `internal_review_pending`, use relay-review against the retained worktree and do not request CodeRabbit, GitHub PR review, or other public PR reviewers.
2. After internal PASS moves the run to `publish_pending`, run `publish-run.js`; the first post-publication relay-review round is the normal point to evaluate CI/actions, CodeRabbit, Codex PR review, and review-thread signals.
3. After publication, trigger external reviewers only for the initial public review or for a meaningful new commit that could change their findings. Do not re-trigger `@coderabbitai review` for comment-only updates, metadata edits, audit-comment rewrites, or small cleanup commits when CI is green and active review threads are resolved.
4. During final closeout, verify the latest CI/checks, unresolved non-outdated review threads, and latest applicable external review status. Do not spend another external review round merely to restate already-clean signals.

This repository does not currently carry a repo-local CodeRabbit auto-review config. If one is added, prefer an opt-in policy for delayed-publication branches, such as manual review requests after publication or a label convention that enables review only after internal LGTM. On rate-limit responses, wait for quota recovery, push a meaningful code commit if one exists, and request manual review only when the new diff needs it; otherwise continue with the available CI and thread evidence.

## Execution Evidence Preflight

Execution evidence preflight is script territory, not AI reviewer judgment. The script can verify file type, JSON schema, reviewed HEAD vs evidence HEAD, strict command/hash/exit fields, and `verification_runs[]` records deterministically before spending a reviewer round. The reviewer still handles semantic code review against Done Criteria and rubric anchors after that mechanical proof is valid.

When preflight blocks, JSON output includes `executionEvidencePreflight.status`, `reason`, `reviewedHeadSha`, `evidenceHeadSha` when a valid artifact exposed one, and `nextAction=repair_execution_evidence`. The same preflight object reports optional `browserEvidence.present`, plus compact browser counts when present: `viewportCount`, `screenshotCount`, `consoleErrors`, and `inspectedStateCount`. When `execution-evidence.json` includes `browser_evidence`, screenshot paths must stay inside the run artifact directory unless the entry is explicitly hash-backed with `sha256`. Repair or regenerate `execution-evidence.json` for the reviewed HEAD, then rerun the same review command. Manual `--review-file` fallback paths intentionally bypass the preflight and keep the older fail-closed verdict override so operators can apply an already-produced verdict without weakening the execution evidence gate.

## Codex Quota Exhaustion

When the Codex CLI exits and its stdout/stderr matches the stable usage-limit prefix `You've hit your usage limit`, `invoke-reviewer-codex.js` fails immediately with the token `codex_quota_exhausted` plus the CLI's retry-at text verbatim. The CLI already exits promptly on quota — the adapter classifies at that failure point and does not retry or wait out the review timeout.

**Stall-then-quota precursor:** Repeated full-timeout stalls whose raw responses only echo the prompt (no verdict) often precede a hard usage-limit wall. Treat that pattern as an operator signal to probe Codex quota before spending another review timeout.

**Fallback lanes:** Switch the primary reviewer with `--reviewer cursor --reviewer-model grok-4.5-high`, or apply an already-produced verdict via the manual `--review-file` playbook (see Execution Evidence Preflight above for the intentional preflight bypass on that path).

## Codex-only Operation Regression

Codex-only operation is covered as a regression for `policy.review_assurance=hardened`, not a Codex-only policy special case. When `roles.orchestrator`, `roles.executor`, and `roles.reviewer` are all `codex`, the runner still follows the same manifest policy contract used by any other role names. Advisory evidence is required for passing hardened rounds, advisory required findings block the pass, and strict execution evidence must bind to the reviewed head.

## Independent Review Attempts

Escalated runs may be reopened for one independent review attempt. A different `--reviewer` records a `reviewer_swap` event with `reason=different_reviewer:<from>-><to>`. Reusing the same adapter requires `--independent-review-reason <text>` so the audit trail explains how the attempt is independent, such as a fresh ephemeral context, different model hint, or materially different prompt bundle.

## Detached Review Rounds (`--detach`)

A review round is the last long-running foreground-fragile step in the pipeline. `--detach` runs the round under a crash-only detached supervisor — the same pattern `dispatch.js` ships (`--detach`, #799–#802) and `run-full-gate.js` ships for gates (#930) — so the round survives the death of the invoking shell.

```bash
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --reviewer codex --detach --json
```

The parent re-execs `review-runner.js` (same argv minus `--detach`, with a receipt env var) in a new process group, waits for the child's receipt, prints it, and exits. The child runs the existing `run()` end-to-end. The receipt carries at least `{ runId, round, pid, pgid, logPath, sentinelPath }` plus `leasePath`, `manifestPath`, and a `recoverCommand`.

Run-dir artifacts the detached round adds (foreground rounds write none of these, staying byte-identical):

- `lease.json` — the run-dir lease written via `run-runtime-state.js` `writeRunLease` (`pid`, `pgid`, `host`, `started_at`, `timeout_s`). Operators identify and kill only this owned `pgid` (`kill -TERM -<pgid>`); the lease is left in place after the round so its shape stays inspectable, and the next detached round overwrites it.
- `review-round-N.done` — the completion sentinel (`{ status: "complete" | "failed", exitCode, finishedAt }`), analogous to the gate `.done` sentinel.

`--detach` composes with the normal round flags (`--reviewer`, `--reviewer-model`, `--advisory-reviewer` and lanes, `--wait-for-checks`, `--no-comment`). It is rejected — with a clear error, not silently ignored — when combined with `--prepare-only` (only emits the prompt bundle) or with a `--review-file` apply (applies an already-produced verdict without invoking the reviewer), because detaching adds nothing there.

### Recovery: killed between verdict persistence and manifest apply

If the detached supervisor is killed after the round persisted its verdict (`review-round-N-verdict.json` / `review-round-N-raw-response.txt` written) but before the manifest apply completed, re-apply the persisted verdict without re-invoking the reviewer using the existing `--review-file` semantics (unchanged by `--detach`):

```bash
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <pr> \
  --review-file ~/.relay/runs/<repo-slug>/<id>/review-round-N-raw-response.txt \
  --manual-review-reason "reapply persisted verdict after detached-round kill"
```

`loadReviewText` short-circuits to the on-disk review text when `--review-file` is passed, so this re-runs the round with the persisted verdict and applies it (`--manual-review-reason` records the provenance in `review.manual_review_reason`). The receipt's `recoverCommand` field spells out this same command for the current run.

## Backward Compatibility

Pre-261 runs do not have `execution-evidence.json`. In that case the runner computes `quality_execution_status=missing`, a reviewer PASS cannot be applied, and operators should use `finalize-run --force-finalize-nonready --reason "pre-261 run, no artifact"` only after independent verification.
