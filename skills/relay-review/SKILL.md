---
name: relay-review
argument-hint: "[run-id or branch-name or PR-number]"
description: Independent PR review against Done Criteria in a fresh context, free from planning bias. Use after dispatch completes and a PR exists.
context: fork
compatibility: Requires gh CLI.
metadata:
  related-skills: "relay, relay-ready, relay-plan, relay-dispatch, relay-merge"
  keywords: "리뷰, 검토, review, gate, fresh context"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`; examples use `PR_NUM`, `BRANCH`, `ISSUE_NUM`, and `RUN_ID`; `ANTHROPIC_API_KEY` is required only for `--reviewer claude`; `RELAY_PI_BIN` can override the Pi binary path.
- Files: PR diff (`/tmp/pr-diff.txt`), Done Criteria anchor, Score Log/rubric artifacts, run manifest, and optional `/tmp/review-verdict.json`; `RELAY_ANTIGRAVITY_BIN` can override the Antigravity reviewer binary path.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/resolve-issue-number.sh`, `${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js`.

# Relay Review

## Use when

- Reviewing an executor PR against frozen Done Criteria and rubric anchors
- Running `review-runner.js` for isolated reviewer invocation, PR comments, and manifest transitions
- Producing a pass, changes-requested, or escalated relay review verdict

## Do not use when

- Shaping an ambiguous task before planning — use `relay-ready`
- Authoring rubrics or dispatch prompts — use `relay-plan`
- Delegating initial implementation or requested fixes — use `relay-dispatch`
- Merging a reviewed PR — use `relay-merge`

## Context Isolation

Reviews MUST run in a fresh context — no prior planning, dispatch, or conversation history. Standard path: `review-runner.js --reviewer codex` or `--reviewer claude`; adapter scripts enforce isolation.

- Claude Code: `context: fork` frontmatter triggers isolation.
- Codex adapter: `invoke-reviewer-codex.js` passes `--ephemeral --sandbox read-only`.
- Claude adapter: `invoke-reviewer-claude.js` passes `--bare --no-session-persistence`; Pi adapter passes `--no-session --tools read,grep,find,ls`; Antigravity adapter invokes the `agy` CLI with `--print --print-timeout ... --sandbox`.
- Manual inline review: start a new session; do not continue from dispatch.
- Other fallback: prefix the prompt with "You are reviewing code you did NOT write. You have no context about why it was written this way."

## Setup: Establish the anchor

1. Get the PR diff and Done Criteria (this runs in a fresh context — fetch everything needed). Runner resolution order and issue inference details are in `references/runner-notes.md`.
```bash
PR_NUM=$(gh pr list --head <branch> --json number -q '.[0].number')
BRANCH=$(gh pr view $PR_NUM --json headRefName -q '.headRefName')
gh pr diff $PR_NUM > /tmp/pr-diff.txt
ISSUE_NUM=$(bash "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/resolve-issue-number.sh" "$PR_NUM" "$BRANCH")  # legacy manual helper; runner resolution is canonical
gh issue view $ISSUE_NUM  # Done Criteria / Acceptance Criteria source
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

Supported built-in adapters: `--reviewer codex`, `--reviewer claude`, `--reviewer pi`, `--reviewer antigravity`.

Notes: `codex` uses read-only structured output; `pi` uses a read/grep/find/ls allowlist plus dirty-worktree checks; `antigravity` targets the `agy` CLI, not GUI/IDE/Desktop flows, and relies on `--sandbox` plus dirty-worktree checks. `claude --bare` needs `ANTHROPIC_API_KEY` or `claude login --api-key`.
Model precedence is `--reviewer-model` -> `manifest.model_hints.review` -> reviewer default. Examples: `review-runner.js --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --reviewer pi --reviewer-model openai/gpt-5 --json`; `review-runner.js --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --reviewer antigravity --reviewer-model google/antigravity-cli --json`.
The adapter capability matrix and checklist are in `../relay-dispatch/references/agent-adapter-platform.md`.

Optional advisory path: add an opencode blind-spot lane alongside the primary reviewer:
```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --reviewer codex --advisory-reviewer opencode --advisory-profile blindspot --json
```

Advisory review is non-gating for `policy.review_assurance=standard`: it starts concurrently, waits only `--advisory-grace` seconds on the critical path, records `advisory_review` plus `review-round-N-advisory-<reviewer>-*`, never changes the trusted verdict or redispatch prompt, and records failures/timeouts/invalid JSON/write-policy violations without changing the primary outcome. Late artifacts are classified as `metrics` after a passing primary decision or `redispatch` after changes requested. If dispatch routing selected `routing.selected.advisory_review.reviewer`, review-runner uses it as the default unless CLI advisory flags override it. For `policy.review_assurance=hardened`, the runner fails fast unless the command or manifest routing supplies an advisory reviewer; advisory failures or required findings block a passing primary verdict, and execution evidence must be strict. When `execution-evidence.json` includes `verification_runs[]`, hardened gates prefer those actual command-run records; otherwise they fall back to legacy `test_exit_code=0` plus a SHA-bound result hash. Use `--advisory-reviewer-model` to override; otherwise opencode uses dispatch executor defaults plus optional `~/.relay/executors.json`. Current profile: `blindspot` checks likely misses such as test gaps, bypass paths, edge cases, stale docs, and operational failure modes.

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
| Converged | ready verdict emitted | `converged` | `ready_to_merge` |
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

8. Inspect changed files inline for code quality, patterns, conventions, and structural issues. Adapter-managed reviewers (Codex, Claude, Pi, Antigravity, and opencode advisory) return findings in the structured verdict; fallback/manual reviewers follow the same contract. Manual or supported environments MAY use helpers such as Claude Code `/review`, but helper availability is optional.
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

11. Both phases pass → produce a structured verdict with `verdict=pass`, `next_action=ready_to_merge`, and `issues=[]`.

**Safety cap: 20 rounds total.** Ceiling, not target — most PRs converge in 1-3 rounds. Hitting the cap means something is structurally wrong; escalate.

## Verdict + Audit Trail

12. If you used the fallback path, apply the structured verdict with the review runner:
```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --review-file /tmp/review-verdict.json
```

The runner validates the verdict, writes the PR audit comment, updates manifest state, and records round artifacts. For hardened runs, a passing manual verdict requires an explicit `--manual-review-reason` audit reason. See `references/runner-notes.md` for the full audit-trail and backward-compatibility behavior.

When an escalated run needs another review attempt, pass a different `--reviewer` when available. If the same adapter is intentionally reused, include `--independent-review-reason <text>` to document why the attempt is independent enough to spend the single reviewer-swap quota.

## Re-dispatch (when issues found)

Use the generated `review-round-N-redispatch.md` artifact as the targeted fix prompt. It already includes the issue list, scope guardrail, and original Done Criteria.

See `references/evaluate-criteria.md` for escalation policy (auto re-dispatch vs ask user).
