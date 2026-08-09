# Relay Preflight Guards

`relay/scripts/run-preflight.js` keeps deterministic guard work outside the
main `/relay` flow. It prints JSON only, including human-readable next-step
instructions that the skill follows without carrying route prose inline.

## Route Stage

Run:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" --stage route --repo . --issue-number "$ISSUE_NUMBER" --branch "$BRANCH" --json
```

The route stage returns `{ok, stage, repo, inflight}` and nothing else. It
carries no readiness key, no score, and no prompt state; readiness is an
orchestrator judgment described in `../../relay-ready/SKILL.md`.

### In-flight PR/run guard

- Firing condition: an issue-numbered task is entering Step 1 routing.
- Signals read: `gh pr list --head <branch> --state all --json number,state,mergedAt,headRefName,url`; validated Relay `run.json` records and canonical `runtime.inspectRun` actions for issue-matching runs.
- Events emitted: none by this guard.
- Instruction field: every in-flight route includes `inflight.instruction`, a one-sentence operator next action.
- Branch labels:
  - `existing-open-pr`: `instruction` tells the operator to review the existing open PR instead of planning or dispatching a new run.
  - `existing-merged-pr`: `instruction` tells the operator to mark the sprint item done if present and stop because the PR is already merged.
  - `inflight-run`: `instruction` tells the operator to resume or inspect the existing run using its derived Relay action.
  - `continue`: `instruction` tells the operator to continue to readiness handling before planning or dispatch.

### Readiness judgment (orchestrator, not a guard)

Readiness left the script layer with #1156. The preflight neither scores it, nor
prompts for it, nor shells out to a probe, so it cannot fail open on a scoring
error the way the retired probe did.

- Firing condition: `inflight.route == "continue"` and Step 1 has task text.
- Signals read: the request text, plus an accepted relay-ready handoff under
  `~/.relay/requests/<repo-slug>/` whose recorded source identity — the issue
  number, the issue URL, or the request id the operator was given — matches this
  issue. Only such a matching handoff supersedes the issue's own criteria
  (canonical matching rule: `../../relay-ready/SKILL.md`); a newer bundle for a
  different issue is irrelevant.
- Events emitted: none.
- Factors: clarity, granularity, verifiability, task shape, and risk, as defined
  in `../../relay-ready/SKILL.md`.

Routes are non-binding labels applied by the orchestrator, not lifecycle states:

- `ready`: a Done Criteria heading, an observable assertion inside that section,
  no high-risk keyword, single-leaf granularity, and no strong task shape.
  Proceed to Step 2.
- `needs_split`: a strong task shape. The default route is `proposal-first`
  relay-ready shaping, which requires an accepted handoff and makes that handoff
  the relay-plan source of truth before dispatch. Skipping it is an explicit
  operator override, never the default route.
- `escalate`: a high-risk keyword together with any low dimension. Confirm scope
  with the operator before dispatch.
- otherwise: ask bounded relay-ready questions until one of the routes holds.

## Review Stage

Run before relay-review to snapshot:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" --stage review --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --json
```

Run after relay-review to compare:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" --stage review --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --previous-rounds "$PREVIOUS_ROUNDS" --previous-verdict "$PREVIOUS_VERDICT" --json
```

Use `--stage merge` at the merge boundary. It resolves and inspects the run
through the same code path; only the response's `stage` label differs.

### Stale-review guard

- Firing condition: Step 4 is about to invoke relay-review, then again immediately after relay-review returns.
- Signals read: immutable `run.json`, append-only review facts, and the fresh Git/GitHub/worktree observations returned by canonical `runtime.inspectRun`.
- Events emitted: none by this guard; relay-review emits its normal review events.
- Branch labels:
  - `snapshot`: before review, store `.snapshot.rounds` and `.snapshot.latest_verdict`.
  - `advanced`: after review, `.comparison.rounds_advanced` or `.comparison.verdict_changed` is true; proceed to Step 5.
  - `stale`: after review, neither value changed; treat the review as stalled and run `review-runner.js` directly in the foreground, then repeat the same comparison.
  - `stale_ready`: canonical inspect returns `action=review` with `reason=review_stale`; rerun relay-review for the observed head.
  - `merge_ready`: canonical inspect returns `action=merge`; the observed PR head is bound to the current passing review.

The JSON also reports `.snapshot.sha_state` / `.comparison.sha_state` as
`reviewed_current_head`, `stale_reviewed_sha`, `not_reviewed`, or
`missing_head_sha` so operators can see whether the folded review SHA is
current without changing the round/verdict advancement rule.

For ready runs, `.ready_status` includes `pr_number`, `old_sha`, `new_sha`,
`reviewed_sha`, `observed_head_sha`, and `next_action`. Recovery is available
only through `--recover`/`--reconcile` with an explicit `--reason`; both invoke
canonical `runtime.recoverRun` and never assign lifecycle state.
