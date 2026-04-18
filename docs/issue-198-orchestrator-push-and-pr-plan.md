# Issue #198 — Move branch push + PR creation from executor to orchestrator

Feature addition (not a refactor). `dispatch.js` currently relies on the executor's sandbox to run `git push` + `gh pr create`, which fails on GHE / self-hosted GitHub. Move those two calls into the outer orchestrator shell where the operator's `gh` auth already works.

This also retires the "executor did not open PR" failure class we observed on #188 round 1 — that observation went into `memory/feedback_executor_did_not_open_pr.md`, but the right long-term fix is to stop depending on the executor for this step.

## Problem statement

Today `dispatch.js` ends at line ~989 (result object construction) with manifest state `review_pending`, trusting the executor to have already pushed + opened a PR during its own subprocess. Four symptoms:

1. On non-default GitHub hosts (GHE / self-hosted), executor-sandbox DNS + `gh auth` fail. Commit lands locally; push/PR silently don't happen. Operator recovers manually.
2. Even on `github.com`, codex sometimes completes the work correctly but declines to open the PR (observed #188 round 1). Orchestrator must recover mechanically.
3. `relay-review` and `relay-merge` have no authoritative `prNumber` on the manifest; they re-query by branch.
4. `reviewer_login` on non-default hosts is wrong (companion bug — not in scope here, tracked separately).

## Goal

After this PR:

- `dispatch.js` pushes the branch and opens the PR in the outer shell after a successful executor run.
- The manifest carries `prNumber` so `relay-review` and `relay-merge` can stop re-querying.
- `--dry-run` unchanged — no push, no PR.
- If push or PR creation fails, status = `failed`, runState = `escalated`, error surfaced.
- If the executor already opened a PR for the branch (backward compat), detect and skip gracefully.
- Dispatch prompts stop instructing executors to open PRs — vestigial and harmful for non-Codex executors that would double-open.

## Proposed shape

New helper in `dispatch.js` (not a new module — the PR body + push logic is ~100 LOC, fits in the existing file without creating a boundary):

```js
// After executor exits with status === "completed" and gitLog is non-empty,
// BEFORE the manifest transitions to review_pending.
async function pushAndOpenPR({ repoRoot, wtPath, branch, baseBranch, resultPreview, runId, rubricPath, manifestPath }) {
  // 1. Detect existing PR for branch; return { prNumber, createdByUs: false } if found.
  // 2. git push -u origin <branch>   (via execFileSync, outer shell)
  // 3. gh pr create --base <base> --head <branch> --title <derived> --body <derived>
  // 4. Parse PR number from gh output.
  // 5. Return { prNumber, createdByUs: true }.
  // Throws on any failure; caller maps to status=failed / runState=escalated.
}
```

Wire into `main()` at the point between status determination (line ~905) and manifest state update (line ~915):

```js
let prNumber = null;
let prCreatedByUs = false;
if (status === "completed" && !DRY_RUN && gitLog) {
  try {
    const pr = await pushAndOpenPR({ ... });
    prNumber = pr.prNumber;
    prCreatedByUs = pr.createdByUs;
  } catch (e) {
    status = "failed";
    error = `push_or_pr_failed: ${e.message}`;
  }
}
```

Manifest writes `prNumber` under `github.pr_number` field. Result JSON adds `prNumber` and `prCreatedByUs` keys.

### PR body + title templating

Title:
```
<commit-subject>
```
(pulled from `git log -1 --format=%s` on the branch HEAD)

Body:
```markdown
## Summary

<first 500 chars of resultPreview, stripped of executor-specific preamble>

## Dispatch metadata

- Run: `<runId>`
- Executor: `<EXECUTOR>`
- Branch: `<branch>`

_Opened by relay-dispatch._
```

If the operator wants richer PR bodies (trust-model audit block etc.), the executor can still write them into `resultPreview` — the orchestrator just forwards.

### Dispatch prompt cleanup

Remove "commit + push + open PR" mechanics sections from any reference prompt templates (`skills/relay-dispatch/references/prompt-template.md` if present, and any inline prompt guidance in SKILL.md). Executors are now only responsible for `git commit`; the orchestrator owns push + PR.

## Rubric (M-size, 5 factors, no trust-model)

This is a feature addition, not a gate refactor. No auth boundary crosses. No byte-identical preservation required. Standard rubric shape.

### Prerequisites

- Baseline: 552/552 tests green on main post-#189.
- `grep -rn 'require.*dispatch' skills/` consumer list unchanged.

### Contract factors

**1. `dispatch.js` pushes + opens PR on successful dispatch; manifest stores `prNumber`**

- After successful executor run (status `completed`, non-dry-run, commits present), `dispatch.js` invokes `git push -u origin <branch>` + `gh pr create` via `execFileSync` from the outer shell.
- Manifest gets `github.pr_number` written; result JSON includes `prNumber`.
- Direct test asserts: given a mock worktree + mocked `gh` CLI, `dispatch.js` returns a result with `prNumber` populated.

**2. `--dry-run` does not push or open a PR**

- Automated test: `dispatch.js --dry-run` with a valid prompt returns `mode: "new"` with no `prNumber` and no network calls.
- Grep guard: dry-run code path does not reach `git push` or `gh pr create`.

**3. Push failure escalates to `failed` / `escalated`**

- Test: with a mocked `git push` that fails, dispatch result has `status: "failed"`, `runState: "escalated"`, and `error` contains `push_or_pr_failed`.
- Manifest state is `escalated`, not `review_pending`.

**4. Existing PR for `<branch>` detected and skipped gracefully**

- Test: if `gh pr list --head <branch> --json number -q '.[0].number'` returns a number before dispatch reaches the `gh pr create` step, dispatch uses that number and sets `prCreatedByUs: false`.
- No error thrown; status remains `completed`.

**5. Executor prompt text no longer instructs PR creation**

- Grep: `skills/relay-dispatch/references/prompt-template.md` and `skills/relay-dispatch/SKILL.md` contain no "open a PR", "push to origin", or similar instructions in executor-facing prose.
- Any troubleshooting row mentioning "push manually" is removed or rewritten to say "orchestrator handles this; check `dispatch.js` error".

### Quality factors (2)

**6. Test coverage**

- New tests in `dispatch.test.js` cover:
  - happy-path push + PR creation (mocked `gh`).
  - `--dry-run` skips push + PR.
  - Push failure → escalated.
  - Existing PR → skip gracefully.
- Test delta: ≥ +6 tests. Baseline 552; target ≥ 558.

**7. Docs mirror + changelog**

- `docs/issue-198-orchestrator-push-and-pr.md` updated post-merge with:
  - What moved (executor → orchestrator).
  - How the `resultPreview` → PR body mapping works.
  - Migration note for non-default-host operators (no more manual push recovery).
  - Reference to retired stopgap (`skills/relay/references/non-default-github-host.md` if that path exists — update or delete).
- `SKILL.md` troubleshooting row for "No PR created" updated or removed.

## Trust-model audit

Not triggered. This task does not cross an auth boundary:

- No `validateTransition*` / `validateManifest*` / `getRubricAnchorStatus` / `evaluateReviewGate` logic touched.
- No rubric gate, no migration manifest cross-check.
- The new code paths (`git push`, `gh pr create`) are host-level operations with no invariants beyond "operator's `gh` auth is valid."
- Manifest write for `prNumber` goes through existing `writeManifest` / `updateManifestState` — no new transition, no new gate.

## Out of scope

- Changing `relay-review` or `relay-merge` to prefer manifest `prNumber` over branch-based lookup. Separate follow-up (`dispatch.js` just has to STORE it; consumers can migrate when convenient).
- Fixing `reviewer_login` on non-default hosts — separate companion issue already tracked.
- Rewriting PR body templating into a full template system. The initial version takes `resultPreview` + dispatcher footer; richer templating is a follow-up.
- Supporting `--no-pr` / `--skip-pr` flags. If an operator wants to dispatch without opening a PR, they can use `--dry-run` or manually manage it.
- Any change to `create-worktree.js` behavior. That's a separate entry point with no PR concept.

## Out of scope — explicitly NOT re-opening

- #189 review-runner decomposition follow-ups.
- Test-file migration from `relay-manifest.js` facade (deferred from #188).
- `relay-intake/scripts/relay-request.js` migration from facade.

## Build sequence

1. Baseline tests 552/552.
2. Add `pushAndOpenPR` helper to `dispatch.js`.
3. Wire into `main()` between status determination and manifest state update.
4. Add `github.pr_number` field to manifest write.
5. Remove executor-facing PR creation prompts from `SKILL.md` / any template files.
6. Add 6+ new tests in `dispatch.test.js` for the four edge cases.
7. Full suite green.
8. Docs mirror `docs/issue-198-orchestrator-push-and-pr.md`.
9. Commit + push + open PR (the orchestrator — that's us, since this PR is the one that introduces the new behavior).

## Expected difficulties

1. **Mocking `gh` CLI in tests.** Options: (a) environment-variable override pointing to a shell script that prints canned responses; (b) abstract the `gh` call behind a function that tests can swap. Prefer (b) — cleaner and avoids file-system fiddling in tests.
2. **Backward compat with existing dispatches in-flight.** If an operator re-dispatches via `--run-id`, and the previous round already opened a PR, the new code must detect that PR. This is the "existing PR skip" case in factor 4.
3. **Manifest schema evolution.** Adding `github.pr_number` is additive; consumers that don't read it are unaffected. But the field should be namespaced under `github.` to match the existing `git.head_sha` pattern.
4. **Error surface.** `git push` and `gh pr create` have heterogeneous error messages. The error in the result JSON should be the human-readable first line, not the full stack trace.

## Next-session execution

1. `node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json`.
2. Finalize rubric.
3. Dispatch via `/relay-dispatch`. Dry-run first.
4. Review — anticipate 2-3 rounds. Likely round-1 miss: insufficient mock isolation in push-failure test.
