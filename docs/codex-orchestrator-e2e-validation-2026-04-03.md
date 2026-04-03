# #28 Codex-as-Orchestrator E2E Validation Report

Date: 2026-04-03

## Scope

Validate the direct-read relay workflow end-to-end in two live tracks:

- Run A: no-sprint run in `dev-relay`
- Run B: sprint-enabled run in a disposable GitHub fixture repo

The bar for success was a real relay cycle with manifest evidence, PR review evidence, explicit squash merge, and documented gaps instead of hidden assumptions.

## Environment

- `codex-cli 0.116.0`
- `gh` authenticated as `sungjunlee`
- `gh` token scopes at validation time: `admin:org`, `gist`, `project`, `repo`, `workflow`

Strict-validator spot check:

```bash
python3 /Users/sjlee/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/relay-review
```

Result:

```text
Unexpected key(s) in SKILL.md frontmatter: argument-hint, compatibility, context. Allowed properties are: allowed-tools, description, license, metadata, name
```

Interpretation:

- This remains a known packaging mismatch with the strict Codex validator.
- It did not block the direct-read validation path.

## Preflight Regression Suite

Executed before or during the live runs against the current branch state:

- `node --test skills/relay-dispatch/scripts/dispatch.test.js` -> pass
- `node --test skills/relay-review/scripts/review-runner.test.js` -> pass
- `node --test skills/relay-merge/scripts/finalize-run.test.js` -> pass
- `node --test skills/relay-dispatch/scripts/close-run.test.js` -> pass
- `node --test skills/relay-dispatch/scripts/reliability-report.test.js` -> pass
- `node --test skills/relay-dispatch/scripts/relay-manifest.test.js` -> pass
- `python3 skills/relay-dispatch/scripts/smoke_dispatch_scenarios.py` -> pass (`success_with_commit` and `noop_escalates` both passed)

## Run A: `dev-relay` Without Sprint

Repository:

- `sungjunlee/dev-relay`

Issue and branch:

- Issue `#48`
- Branch `issue-48`

Exact operator prompt used for the successful run:

```text
You are a fresh Codex session performing a direct-read relay validation for issue #48 in /Users/sjlee/workspace/active/harness-stack/dev-relay.

Requirements:
- Start by opening these files and nothing broader unless needed:
  - /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay/SKILL.md
  - /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay-merge/SKILL.md
- Do not assume installed skills. This is validating direct file-read behavior.
- Execute the relay cycle with the exact repo-local scripts and prompt file that already exist.
- Keep the run narrow and command-driven; do not do broad repo exploration.

Sequence:
1. In the repo root, run `git fetch origin`.
2. Confirm issue #48 exists and there is no open PR on branch `issue-48`.
3. Run `node skills/relay-dispatch/scripts/dispatch.js . -b issue-48 --prompt-file /tmp/dispatch-48.md --timeout 3600 --copy-env --json`.
4. Parse the JSON output for `runId`, `manifestPath`, and `runState`.
5. If dispatch fails, inspect `stderrLog` and `stdoutLog`, summarize the blocker, and stop with JSON.
6. If dispatch succeeds, get the PR number from `gh pr list --head issue-48 --json number,url`.
7. Run `node skills/relay-review/scripts/review-runner.js --repo . --run-id <runId> --pr <pr> --reviewer codex --json`.
8. If the review verdict requests changes, run the generated redispatch prompt from `.relay/runs/<runId>/review-round-1-redispatch.md` with `dispatch.js --run-id <runId> --prompt-file ... --json`, then review again. Repeat until `ready_to_merge` or `escalated`.
9. If the run reaches `ready_to_merge`, run `node skills/relay-merge/scripts/finalize-run.js --repo . --run-id <runId> --merge-method squash --json`.
10. Return JSON only with: issue_number, run_id, manifest_path, pr_number, pr_url, review_comment_url, merge_commit, final_state, notes.
```

Evidence:

- Initial failed retained run: `issue-48-20260403122737248`
- Initial failed manifest: `.relay/runs/issue-48-20260403122737248.md`
- Initial failed events: `.relay/runs/issue-48-20260403122737248/events.jsonl`
- Successful run id: `issue-48-20260403123241947`
- Successful manifest: `.relay/runs/issue-48-20260403123241947.md`
- Successful events: `.relay/runs/issue-48-20260403123241947/events.jsonl`
- Dispatch prompt: `/tmp/dispatch-48.md`
- PR: [#49](https://github.com/sungjunlee/dev-relay/pull/49)
- Relay-review comment: [issuecomment-4183323035](https://github.com/sungjunlee/dev-relay/pull/49#issuecomment-4183323035)
- Merge commit: `c0c87dfd28c50541c46591c0949455a7860f7e47`
- Final manifest state: `merged`

Observed sequence:

1. First live attempt exposed two real blockers:
   - nested Codex dispatch could stall while stderr noise accumulated
   - multiline cleanup errors could make a manifest unreadable by frontmatter consumers
2. After the dispatch/logging and manifest serialization fixes, the second run completed dispatch and review.
3. `gh pr create` still failed from inside the nested Codex worker, so the PR was created externally and the run continued from the same manifest.
4. `relay-review` passed in round 1.
5. `relay-merge` had to recover from an already-merged PR after `gh pr merge --delete-branch` collided with the retained worktree branch.

## Run B: Fixture Repo With Sprint File

Repository:

- `sungjunlee/dev-relay-e2e-fixture-20260403212426`
- Local checkout: `/tmp/dev-relay-fixture-28-2L1ABB/fixture`

Issue and branch:

- Issue `#1`
- Branch `issue-1`

Exact operator prompt used for the successful direct-read kickoff:

```text
You are a fresh Codex session performing a direct-read relay validation for issue #1 in /tmp/dev-relay-fixture-28-2L1ABB/fixture.

Requirements:
- Start by opening only these files unless you are blocked:
  - /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay/SKILL.md
  - /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay-merge/SKILL.md
- Do not assume installed skills. This validates direct file-read behavior.
- Keep the run narrow and command-driven. Do not do broad repo exploration.
- This must be a live GitHub-backed run, not an offline fixture simulation.

Context:
- Repo root: /tmp/dev-relay-fixture-28-2L1ABB/fixture
- Local task file: /tmp/dev-relay-fixture-28-2L1ABB/fixture/backlog/tasks/FIXTURE-1 - Add fixture operator note.md
- Active sprint file: /tmp/dev-relay-fixture-28-2L1ABB/fixture/backlog/sprints/ACTIVE.md
- Remote repo: sungjunlee/dev-relay-e2e-fixture-20260403212426

Sequence:
1. Run `git fetch origin`.
2. Confirm issue #1 exists and there is no open PR on branch `issue-1`.
3. Write a dispatch prompt to `/tmp/dispatch-fixture-1.md` based on the local task file with a rubric-backed documentation task.
4. Run `node /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay-dispatch/scripts/dispatch.js . -b issue-1 --prompt-file /tmp/dispatch-fixture-1.md --timeout 3600 --copy-env --json`.
5. Parse the JSON for `runId`, `manifestPath`, `runState`, `stderrLog`, and `stdoutLog`.
6. If dispatch fails, inspect `stderrLog` and `stdoutLog`, summarize the blocker, and stop with JSON.
7. If dispatch succeeds, get the PR number and URL from `gh pr list --head issue-1 --json number,url`.
8. Run `node /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay-review/scripts/review-runner.js --repo . --run-id <runId> --pr <pr> --reviewer codex --json`.
9. If review returns `changes_requested`, use the generated redispatch prompt from `.relay/runs/<runId>/review-round-<n>-redispatch.md` with `dispatch.js --run-id <runId> --prompt-file ... --json`, then review again. Repeat until `ready_to_merge` or `escalated`.
10. If the run reaches `ready_to_merge`, run `node /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay-merge/scripts/finalize-run.js --repo . --run-id <runId> --merge-method squash --json`.
11. Inspect the merged sprint file on `main` and capture the actual Plan/Progress/Running Context mutations.
12. Return JSON only with this exact shape:
{
  "issue_number": 1,
  "branch": "issue-1",
  "run_id": "...",
  "manifest_path": "...",
  "pr_number": 0,
  "pr_url": "...",
  "review_comment_url": "...",
  "merge_commit": "...",
  "final_state": "merged|ready_to_merge|changes_requested|escalated",
  "sprint_file": "...",
  "sprint_summary": ["..."],
  "notes": ["..."]
}
```

Evidence:

- Run id: `issue-1-20260403125142775`
- Manifest: `/tmp/dev-relay-fixture-28-2L1ABB/fixture/.relay/runs/issue-1-20260403125142775.md`
- Events: `/tmp/dev-relay-fixture-28-2L1ABB/fixture/.relay/runs/issue-1-20260403125142775/events.jsonl`
- Dispatch prompt: `/tmp/dispatch-fixture-1.md`
- Round 1 redispatch prompt: `/tmp/dev-relay-fixture-28-2L1ABB/fixture/.relay/runs/issue-1-20260403125142775/review-round-1-redispatch.md`
- PR: [#2](https://github.com/sungjunlee/dev-relay-e2e-fixture-20260403212426/pull/2)
- Review round 1 comment: [issuecomment-4183372067](https://github.com/sungjunlee/dev-relay-e2e-fixture-20260403212426/pull/2#issuecomment-4183372067)
- Review round 2 LGTM comment: [issuecomment-4183378881](https://github.com/sungjunlee/dev-relay-e2e-fixture-20260403212426/pull/2#issuecomment-4183378881)
- Merge commit: `64a8c15defd9a90a23e57225f87b97c6a5d0d5f7`
- Final manifest state: `merged`

Observed sequence:

1. Direct-read kickoff succeeded in a fresh Codex session after rerunning with `danger-full-access`; the initial `workspace-write` run could read local files but could not reliably reach GitHub.
2. Dispatch succeeded and pushed branch `issue-1`, but `gh pr create` again failed from inside nested Codex with `error connecting to api.github.com`.
3. The PR was created externally against the already-pushed branch.
4. `relay-review` naturally returned `changes_requested` in round 1 because the operator note told reviewers to verify a sprint-file mutation that was not present in the PR diff.
5. Same-run resume reused the same `run_id`, retained worktree, and branch, added the missing sprint artifact, and pushed follow-up commit `95508109a34ce3183ffd69ca459329c92a9eba78`.
6. `relay-review` round 2 passed and the run merged successfully.

Sprint-file verification on merged `main`:

- Plan remained `- [ ] #1 Add fixture operator note`
- Progress gained `- 2026-04-03 21:57: Relay run recorded the fixture operator note update for issue #1.`
- Running Context remained unchanged

Interpretation:

- The same-run control loop is real in practice: `review_pending -> changes_requested -> same_run_resume -> review_pending -> ready_to_merge -> merged`
- Sprint-file side effects are only partially implemented today; the live run produced a real Progress artifact but did not automate `[ ] -> [~] -> [x]` or add a reusable Running Context note

## Code Changes Triggered By Validation

Minimal blockers fixed in this repo during the live runs:

- `skills/relay-dispatch/scripts/dispatch.js`
  - redirect nested Codex stderr to a file instead of an in-memory pipe
  - expose `stderrLog` in dry-run and final JSON
- `skills/relay-dispatch/scripts/relay-manifest.js`
  - serialize multiline scalar values safely in frontmatter
- `skills/relay-review/scripts/review-runner.js`
  - normalize phase-1 `pass + quality_status=not_run` into a mergeable pass
  - make the prompt explicitly require `quality_status=pass` on a pass verdict
- `skills/relay-merge/scripts/finalize-run.js`
  - stop relying on `gh pr merge --delete-branch`
  - recover cleanly when a PR is already merged but the manifest still says `ready_to_merge`

## Known Gaps

- Nested Codex sessions can still push with git but fail GitHub API calls such as `gh pr create` and some `gh pr list/view` requests with `error connecting to api.github.com`. Both live runs hit this.
- `codex exec --full-auto` and `codex exec --dangerously-bypass-approvals-and-sandbox` behaved differently for GitHub reachability in the fixture repo. The top-level orchestrator could re-anchor and query GitHub once rerun without sandboxing, but the nested worker still failed `gh pr create` while `git push` succeeded.
- Sprint-file automation is incomplete. The live sprint run proved the same-run loop and produced a real Progress artifact, but the expected Plan `[~] -> [x]` transition and merge-time Running Context update are still operator/manual work.
- The strict skill validator still rejects repo frontmatter keys (`argument-hint`, `compatibility`, `context`). This remains non-blocking for direct-read usage and blocking only for strict packaging validation.

## Bottom Line

`#28` is validated for the direct-read path at the relay lifecycle level:

- real dispatch manifests were produced
- real PR review comments were produced
- a real `changes_requested -> same_run_resume -> LGTM -> merge` loop completed
- cleanup and manifest finalization completed

What remains is not the same-run control loop itself. The remaining work is mostly transport and packaging polish:

- nested GitHub API reliability inside Codex worker/orchestrator sessions
- sprint-file automation parity with the skill text
- strict validator compatibility for packaged skills
