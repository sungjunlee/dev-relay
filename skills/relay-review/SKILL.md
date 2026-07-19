---
name: relay-review
argument-hint: "[run-id or branch-name or PR-number]"
description: Use when completed relay executor work needs independent review against frozen Done Criteria — internal pre-publication rounds or post-publication PR rounds.
context: fork
compatibility: Requires gh CLI.
metadata:
  related-skills: "relay, relay-ready, relay-plan, relay-dispatch, relay-merge"
  keywords: "리뷰, 검토, review, gate, fresh context"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`; examples use `PR_NUM`, `BRANCH`, and `RUN_ID`.
- Files: PR diff (`/tmp/pr-diff.txt`), Done Criteria anchor, structured evaluation or legacy rubric artifacts, run manifest, and optional `/tmp/review-verdict.json`.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js`.

# Relay Review

## Use when

- Reviewing an executor PR against frozen Done Criteria, Verification evidence, and optional Earned Rubric anchors
- Running `review-runner.js` for isolated reviewer invocation, PR comments, and manifest transitions
- Producing a pass, changes-requested, or escalated relay review verdict

## Do not use when

- Shaping an ambiguous task before planning — use `relay-ready`
- Authoring rubrics or dispatch prompts — use `relay-plan`
- Delegating initial implementation or requested fixes — use `relay-dispatch`
- Merging a reviewed PR — use `relay-merge`

## Context Isolation

Reviews MUST run in a fresh context: no prior planning, dispatch, or conversation history. Standard path: let `review-runner.js` invoke a supported reviewer; adapter isolation and provider-specific invocation details live in `../relay-dispatch/references/agent-adapter-platform.md`.

Manual fallback also needs a new session. Do not continue from dispatch, and do not review inline in the orchestrator context.

## Setup: Establish the anchor

1. Get the PR diff and Done Criteria when preparing a manual/fallback review. Runner resolution order and issue inference details are in `references/runner-notes.md`.
```bash
PR_NUM=$(gh pr list --head <branch> --json number -q '.[0].number')
BRANCH=$(gh pr view $PR_NUM --json headRefName -q '.headRefName')
gh pr diff $PR_NUM > /tmp/pr-diff.txt
gh issue view <N>  # Done Criteria / Acceptance Criteria source; infer <N> per runner-notes.md issue inference
```

2. **Fix the anchor** — these do NOT change across rounds:
   - Done Criteria from `anchor.done_criteria_path` when present, otherwise from the issue (the contract)
   - Rubric factors + targets from the Score Log (if relay-plan was used)
   - Original scope boundary ("do not change" areas)

3. Preferred path: let the review runner invoke an isolated reviewer directly:
```bash
RUN_ID=<run-id-from-dispatch>
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --reviewer codex --json
```

Run the runner in the foreground. Do NOT background it, detach it, or return with "I'll wait for the background runner." The relay-review result is the runner's verdict; do not return until the runner exits and the new `review-round-N-verdict.json` exists.

Supported primary reviewers: `--reviewer codex`, `--reviewer claude`, `--reviewer opencode`, `--reviewer pi`, `--reviewer antigravity`, and `--reviewer cursor`. Adapter precedence, environment knobs, capability gates, and model examples live in `../relay-dispatch/references/agent-adapter-platform.md`.
If a reviewer route is denied or its model is unresolved, run `relay-config` to register the route or set the reviewer default before re-running review.

Optional advisory lanes run alongside the primary reviewer from list config in routing or CLI shorthand. Profiles: `blindspot` defaults to `trigger=every_round,gating=false`; `adversarial` defaults to `trigger=on_pass,gating=true`. Explicit trigger/gating values win. Triggers are `every_round` or `on_pass`; gating lanes can demote an applied pass when they report required findings.
```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --reviewer codex --advisory-reviewer <name> --advisory-profile blindspot --json
```
Supported advisory reviewers: `--advisory-reviewer opencode`, `--advisory-reviewer pi`, `--advisory-reviewer antigravity`, and `--advisory-reviewer cline`.

Full advisory timing, failure, demotion cap, and route semantics are in `references/runner-notes.md` and the adapter platform reference.

4. Fallback path for unsupported environments or debugging:
```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --branch "$BRANCH" --pr "$PR_NUM" --prepare-only --json
```

This writes round artifacts under `~/.relay/runs/<repo-slug>/<run-id>/`. See `references/runner-notes.md` for artifact names, retained-checkout behavior, stale-SHA handling, and repeated-issue escalation.

## Review Loop
| current_phase | outcome | event | next_phase |
|---------------|---------|-------|------------|
| Phase 1 | pass | `phase1_pass` | Phase 2 |
| Phase 1 | fail | `phase1_fail` | Re-dispatch, then Phase 1 |
| Phase 2 | pass | `phase2_pass` | Converged |
| Converged (internal) | ready-to-publish verdict emitted | `converged` | `publish_pending` |
| Converged (post-publication) | ready verdict emitted | `converged` | `ready_to_merge` |
| Phase 2 | fail | `phase2_fail` | Re-dispatch, then Phase 1 |
| Any phase | same issue 3+ rounds or safety cap hit | `escalated` | Escalated |

Two phases, run in order. Each round re-measures against the **original anchor**, not the previous round's state.

### Phase 1: Spec Compliance

5. Review the diff against Done Criteria (see `references/reviewer-prompt.md` or the generated `review-round-N-prompt.md`):
   - **Faithfulness**: Each Done Criteria item implemented? Scope respected?
   - **Stubs/placeholders**: Any `return null`, empty bodies, TODO in production paths?
   - **Integration**: Does it break callers/consumers of changed code?
   - **Security**: Auth/token handling, input validation, injection risks?

6. **Rubric verification** (when Score Log present):
   - Do not copy `rubric.yaml` or run artifacts into the worktree; runner rubric resolution is run-dir-relative by design (see `references/runner-notes.md`)
   - The reviewer evaluates `quality_review_status` by inspection; the runner independently verifies `quality_execution_status` via a SHA-bound execution-evidence artifact. The reviewer cannot execute code, so quality evidence comes from two trust roots.
   - Re-score ALL evaluated quality factors with fresh eyes (0-10) and include numeric `score` / `target_score`; contract factors stay pass/fail and may use `null` numeric fields
   - Any required factor below target → issue
   - The runner computes executor/reviewer divergence and re-dispatches toward the weakest below-target quality factor before falling back to generic issue repair

7. **Phase 1 gate**: Issues found → return a structured verdict with `verdict=changes_requested`, then re-dispatch (see Re-dispatch below). Do NOT proceed to Phase 2 until Phase 1 passes.

### Phase 2: Code Quality (only after Phase 1 PASS)

8. Inspect changed files inline for code quality, patterns, conventions, and structural issues. Adapter-managed primary reviewers (Codex, Claude, OpenCode, Pi, and Antigravity) return findings in the structured verdict; advisory reviewers return advisory JSON. Fallback/manual reviewers follow the primary verdict contract. Manual or supported environments MAY use helpers such as Claude Code `/review`, but helper availability is optional.
9. Inspect changed files inline for simplification opportunities: unnecessary complexity, dead code, verbose patterns, and hard-to-review structure. Manual or supported environments MAY use helpers such as `/simplify`; simplification findings are merge-blocking only when they affect maintainability, correctness risk, or reviewability, not style nits.
10. The structured verdict is the single Phase 2 gating output. No reviewer blocks or fails merely because an external skill command is unavailable. Issues found → return `verdict=changes_requested`, then follow the `phase2_fail` back-edge: re-dispatch and restart at Phase 1 because quality fixes can regress spec compliance.

### Drift and stuck detection (both phases)

Before any re-dispatch, check:
- **Scope:** Does the fix address a review issue, or is it scope creep?
- **Regression:** Are previously passing rubric factors still passing?
- **Churn:** Is the total diff growing without convergence?
- **Score trend:** Is the same quality factor flat for 3 rounds? If yes, pivot implementation approach without expanding scope, or escalate.
- **Stuck:** Same issue 3+ consecutive rounds → escalate immediately (not fixable by the executor).

### Converge

11. Both phases pass → produce a structured verdict with `verdict=pass` and `issues=[]`. Use `next_action=publish_pending` when the manifest state is `internal_review_pending`; use `next_action=ready_to_merge` when the manifest state is `review_pending`.

**Safety cap: 20 rounds total.** Ceiling, not target — most PRs converge in 1-3 rounds. Hitting the cap means something is structurally wrong; escalate.

## Verdict + Audit Trail

12. If you used the fallback path, apply the structured verdict with the review runner:
```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --review-file /tmp/review-verdict.json
# For internal_review_pending before PR publication, omit --pr:
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --run-id "$RUN_ID" --review-file /tmp/review-verdict.json
```

The runner validates the verdict, writes the PR audit comment only for post-publication rounds, updates manifest state, and records round artifacts. Internal rounds use the retained worktree diff and never comment on a PR. For hardened runs, a passing manual verdict requires an explicit `--manual-review-reason` audit reason. See `references/runner-notes.md` for the full audit-trail and backward-compatibility behavior.

When an escalated run needs another review attempt, pass a different `--reviewer` when available. If the same adapter is intentionally reused, include `--independent-review-reason <text>` to document why the attempt is independent enough to spend the single reviewer-swap quota.

## Re-dispatch (when issues found)

Use the generated `review-round-N-redispatch.md` artifact as the targeted fix prompt. It already includes the issue list, scope guardrail, and original Done Criteria.

See `references/evaluate-criteria.md` for escalation policy (auto re-dispatch vs ask user).
