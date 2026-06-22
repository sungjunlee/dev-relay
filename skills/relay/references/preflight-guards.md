# Relay Preflight Guards

`relay/scripts/run-preflight.js` keeps deterministic guard work outside the
main `/relay` flow. It prints JSON only. The skill keeps the decision layer,
including the readiness `AskUserQuestion(...)` branch.

## Route Stage

Run:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" --stage route --repo . --issue-number "$ISSUE_NUMBER" --branch "$BRANCH" --body-file "$ISSUE_BODY_FILE" --manifest "$RUN_MANIFEST" --json
```

### In-flight PR/run guard

- Firing condition: an issue-numbered task is entering Step 1 routing.
- Signals read: `gh pr list --head <branch> --state all --json number,state,mergedAt,headRefName,url`; non-terminal manifests for the issue via relay-dispatch manifest storage.
- Events emitted: none by this guard.
- Branch labels:
  - `existing-open-pr`: open PR found; skip plan/dispatch and review the existing PR.
  - `existing-merged-pr`: merged PR found; update sprint completion if present and stop.
  - `inflight-run`: non-terminal run manifest found; resume or inspect that run.
  - `continue`: no in-flight work found; continue to readiness handling.

### Readiness probe + chain prompt guard

- Firing condition: Step 1 has task text and no prior relay-ready handoff with `readiness_score` plus frozen review anchor, no explicit `--bypass-readiness`, and no sprint-batch relay-ready handoff.
- Signals read: deterministic output from `relay-ready/scripts/probe-readiness.js --json`; optional manifest/events path for the probe's own journal write; current TTY/non-interactive prompt allowance.
- Events emitted:
  - `readiness_probe`: emitted by `probe-readiness.js` when a manifest/events path is supplied.
  - `bypass_override_by_user`: emitted by the skill decision layer for `chain-n`.
  - `readiness_check_failed`: emitted by the skill decision layer for `chain-abort`.
  - `readiness_check_failed_nontty`: emitted by the skill decision layer for `noninteractive-fail`.
- Branch labels:
  - `bypass`: route decision is `ready_single`; probe returns `bypass=true`; proceed to Step 2.
  - `ready-light`: route decision is `ready_light`; readiness returned `next_action=proceed` without a bypass anchor; proceed to Step 2 using S-size quick planning and compact rubric guidance.
  - `chain-y`: probe returns `bypass=false`, prompt is allowed, user answers `y`; invoke relay-ready Q&A, persist the handoff, set `manifest.anchor.readiness`, then resume Step 2.
  - `chain-n`: probe returns `bypass=false`, prompt is allowed, user answers `n`; emit `bypass_override_by_user` with the script's event payload and proceed to Step 2.
  - `chain-abort`: probe returns `bypass=false`, prompt is allowed, user answers `abort`; emit `readiness_check_failed` with the script's event payload and close the run.
  - `noninteractive-fail`: route decision is `readiness_prompt` or `needs_split` and no prompt is allowed; emit `readiness_check_failed_nontty` with the script's event payload and close the run.

Route decisions are advisory labels, not lifecycle states:

- `ready_single`: preserve the existing bypass fast path.
- `ready_light`: keep the task on relay, but plan it as a small quick task with compact rubric guidance. This is only for non-bypass `next_action=proceed` results with no high-risk readiness signal.
- `readiness_prompt`: preserve the existing `qa_needed` prompt or non-interactive failure behavior.
- `needs_split`: strong task-shape signals indicate decomposition should be considered before dispatch; use the same prompt/non-interactive failure mechanics as readiness gaps.

Do not move the readiness prompt into the script. The exact prompt remains:
`AskUserQuestion("Readiness gaps detected: ${SUMMARY}. Invoke relay-ready first? [y/n/abort]")`.

## Review Stage

Run before relay-review to snapshot:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" --stage review --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --json
```

Run after relay-review to compare:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" --stage review --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --previous-rounds "$PREVIOUS_ROUNDS" --previous-verdict "$PREVIOUS_VERDICT" --json
```

### Stale-review guard

- Firing condition: Step 4 is about to invoke relay-review, then again immediately after relay-review returns.
- Signals read: target manifest `review.rounds`, `review.latest_verdict`, `git.head_sha`, and `review.last_reviewed_sha`; for `ready_to_merge` runs, live PR `headRefOid` from GitHub.
- Events emitted: none by this guard; relay-review emits its normal review events.
- Branch labels:
  - `snapshot`: before review, store `.snapshot.rounds` and `.snapshot.latest_verdict`.
  - `advanced`: after review, `.comparison.rounds_advanced` or `.comparison.verdict_changed` is true; proceed to Step 5.
  - `stale`: after review, neither value changed; treat the review as stalled and run `review-runner.js` directly in the foreground, then repeat the same comparison.
  - `stale_ready`: when `.snapshot.state == "ready_to_merge"` and `.ready_status.status == "stale_ready"`, the PR advanced after the passing review; run `recover-state.js --to review_pending --reason <why>` and then run relay-review again.
  - `merge_ready`: when `.snapshot.state == "ready_to_merge"` and `.ready_status.status == "merge_ready"`, the live PR HEAD still matches the reviewed/manifest SHA.

The JSON also reports `.snapshot.sha_state` / `.comparison.sha_state` as
`reviewed_current_head`, `stale_reviewed_sha`, `not_reviewed`, or
`missing_head_sha` so operators can see whether the manifest's review SHA is
current without changing the round/verdict advancement rule.

For ready runs, `.ready_status` includes `pr_number`, `old_sha`, `new_sha`,
`reviewed_sha`, `manifest_head_sha`, and `next_action` so recovery can be
audited without manually editing the manifest.
