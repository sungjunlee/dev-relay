---
milestone: Sprint 2026-05 — Workflow Foundation
status: completed
started: 2026-05-02
completed: 2026-05-02
due: 2026-05-08
---

# 2026-05 Workflow Foundation

## Goal

Lock in the **lane policy**: dev-relay is the manifest-backed lifecycle contract for high-risk PR-bound work, and external tools (Codex `/goal`, gstack, superpowers, Compound Engineering, opencode) live around it as optional aids — not hard dependencies and not a new automatic router. This sprint is the documentation + prompt-language layer of that decision, plus two narrow recovery/cleanup follow-ups.

Strategic frame (from epic #366 and project memory):
- dev-relay = lifecycle contract. Frozen Done Criteria → dispatch evidence → isolated review → merge gates → recovery.
- External tools = optional. No `relay-route` skill, no automatic lane selector, no internals coupling.
- Sidecars / opencode executor work = later milestones. Not in this sprint.

## Plan

### Batch 0 — Tiny cleanup (direct, no relay)
- [x] **#351** chore: drop dead `DEFAULT_REASONING_BY_SIZE` at `dispatch.js:164` → PR #382 (merged `30c5b65`)
  - Lane: **direct** (XS, 1-line removal; relay would be pure overhead).
  - Verification: `grep -n "DEFAULT_REASONING_BY_SIZE" skills/relay-dispatch/scripts/dispatch.js` returns zero, focused dispatch tests stay green.
  - Tests: `node --test tests/relay-dispatch/scripts/dispatch.test.js` (and the rubric-size companion).

### Batch 1 — Workflow lane policy doc (#369)
- [x] **#369** Document workflow lane policy before building a router → PR #383 (merged `35b302f`); `docs/workflow-lanes.md`
  - Lane: **direct or relay** — doc-only with a tight decision-table shape; choose direct unless we want dogfooding signal on a docs PR.
  - Output: lane decision table in `docs/` covering fast / goal / relay / review-only / sidecar lanes; escalation thresholds; four worked examples (small bugfix, risky state-machine change, docs sync, review-only PR).
  - Anchor: must explicitly state "policy documentation, not a new router."
  - Stop at `ready_to_merge` if relayed; do not merge unless asked.

### Batch 2 — Codex `/goal` audit wording in dispatch prompt (#370)
- [x] **#370** Borrow Codex goal completion audit into relay dispatch prompts → PR #385 (merged `deaa918`); 1 dispatch + 1 review round (R1 PASS clean)
  - Lane: **relay** (touches `skills/relay/references/prompt-template.md` plus possibly the rubric template; reviewer signal on prompt-language drift is high-value).
  - Output: dispatch prompt gets an objective→artifact checklist before completion, plus an explicit "tests/manifests/PR descriptions/self-reports are proxy signals, not proof" warning. Wording must complement (not duplicate) Done Criteria + rubric anchors.
  - Reviewer/executor: codex + codex.
  - Stop at `ready_to_merge`.

### Batch 3 — gstack/superpowers/CE workflow doc (#371)
- [x] **#371** Document gstack, superpowers, and Compound Engineering usage around relay → PR #384 (merged `1723984`); `docs/external-tool-workflow.md`
  - Lane: **direct or relay** depending on scope (likely direct; small bridging doc).
  - Output: doc capturing where superpowers (brainstorming, debugging, TDD, verification, receiving-code-review) and gstack (office-hours, plan-ceo-review, plan-eng-review, review, qa, ship, retro) fit; CE framed as specialist review / learning capture, not a fourth orchestration layer; explicit "dev-relay does not hard-depend on these tools."
  - Stop at `ready_to_merge` if relayed.

### Batch 4 — Recovery CLI (#332)
- [x] **#332** Expose `rebrandEvidence` as standalone CLI for orchestrator-side correction commits → PR #386 (merged `1cac868`); 1 dispatch (sandbox blocked git add → recover-commit) + 2 review rounds (R1 changes_requested on under-specified recovery-playbook decision tree, R2 PASS clean after codex rewrote paragraph as 3-case tree)
  - Lane: **relay** (script + tests + docs; classic codex-heavy work, reviewer surface is real).
  - Output: `skills/relay-dispatch/scripts/rebrand-evidence.js` CLI, `--run-id`/`--reason` (+ optional `--repo`/`--manifest`/`--dry-run`/`--json`), happy-path/`sha_unchanged`/`no_existing_evidence` tests, `EVENTS.EXECUTION_EVIDENCE_REBRANDED` event, CLAUDE.md "Common Commands" example, recovery-playbook paragraph clarifying when to use this vs. `recover-commit` vs. `force-finalize-nonready`.
  - Reviewer/executor: codex + codex.
  - Stop at `ready_to_merge`.

### Epic tracker (no code)
- [x] **#366** Epic — workflow lane policy. All three children landed (#369 #370 #371) on 2026-05-02; closing epic as a sprint side-effect.

## Running Context

- **Strategic anchor**: dev-relay is the lifecycle contract layer, not a router. External tools optional. Sidecars / opencode = later milestones.
- **Default workflow**: codex executor + codex reviewer (memory `feedback_prefer_codex_heavy_workflow`). Use Claude only when there is a specific reason.
- **Doc home**: `docs/` for cross-skill workflow docs (#369, #371); `skills/<skill>/references/` for skill-specific operator docs (#332 recovery playbook).
- **Prompt template home**: base prompt at `skills/relay/references/prompt-template.md`. Rubric-flavored templates under `skills/relay-plan/references/`. #370 lands in the base template plus any rubric-design doc that mentions completion behavior.
- **Test baseline at sprint start**: latest main is `3d40593 Promote rubric quality scores into relay iteration`. Run focused suites first; expand to full `node --test tests/relay-*/scripts/*.test.js` only when shared scripts or prompt behavior change.
- **In-flight check before relay dispatch**: scan `~/.relay/runs/<repo-slug>/issue-<N>-*.md` and `git worktree list` first (memory `feedback_dispatch_inflight_run_check`).
- **Stop-at-ready_to_merge rule**: this sprint never merges without an explicit operator instruction. Capture run ID, PR number, review verdict, and final state in the progress log; transition `[ ]` → `[~]` (in-flight) → `[x]` (merged) only after that.
- **Untracked triage artifacts**: `backlog/triage/.cache/2026-05-02T00-58-05Z.json` and `backlog/triage/2026-05-02-report.md` exist as untracked. Do not delete or overwrite without explicit operator approval.
- **Stale 2026-04 sprint**: `2026-04-agentic-patterns-phase-0.md` still says `status: active`. This sprint takes over execution focus; that file's status is a separate cleanup, not in this sprint's scope.

## Progress

- 2026-05-02 01:37 UTC: Sprint file created. Re-anchor clean — branch `main` (post-`/remote-control` orchestrator session), `git status` clean, `git fetch origin` ok, latest main `3d40593`. Five issues + epic confirmed in milestone #5. Next action: Batch 0 (#351), direct minimal removal of `dispatch.js:164` constant, then focused `dispatch.test.js` run.
- 2026-05-02 01:54 UTC: **Batch 0 / #351 merged.** Direct PR #382 (`chore/issue-351-drop-dead-default-reasoning` → `30c5b65`). 1 line deletion. `dispatch.test.js` 100/100 green; `cli-args.test.js` co-run 117/117. CI green (test job + CodeRabbit). Squash-merged. Next action: Batch 1 (#369), lane policy doc — direct (single doc, decision-table shape) under `docs/`.
- 2026-05-02 02:02 UTC: **Batch 1 / #369 merged.** Direct PR #383 (`docs/issue-369-workflow-lane-policy` → `35b302f`). New `docs/workflow-lanes.md` (90 lines): five lanes table, decision table by task shape, five escalation triggers, four worked examples. Forward-links to #370/#371 companions. CI: test pass; CodeRabbit rate-limited but pass status. Squash-merged. Next action: Batch 2 (#370), dispatch prompt completion-audit wording — relay (codex+codex) since prompt template is the contract surface and reviewer signal matters.
- 2026-05-02 02:08 UTC: **Batch 3 / #371 merged in parallel** while #370 codex was running. Direct PR #384 (`docs/issue-371-external-tool-workflow` → `1723984`). New `docs/external-tool-workflow.md` (69 lines): gstack/superpowers/CE positioning tables, anti-patterns, Tool Independence Statement.
- 2026-05-02 02:08 UTC: **Batch 2 / #370 merged.** Relay PR #385 (`issue-370` → `deaa918`); run-id `issue-370-20260502020016945-6b9a0cae`. Codex executor 1 dispatch ~6 min, codex reviewer R1 PASS clean (verdict `pass`, state `ready_to_merge`, rubricStatus `satisfied`). 6 lines added (4 to `prompt-template.md` `## Completion Audit`, 2 to `rubric-reference-contract.test.js` assertions). CI green. `finalize-run.js` squash + worktree cleanup. Next action: Batch 4 (#332), rebrand-evidence CLI — relay (codex+codex), files prepped at `/tmp/done-criteria-332.md`.
- 2026-05-02 02:26 UTC: **Batch 4 / #332 merged.** Relay PR #386 (`issue-332` → `1cac868`); run-id `issue-332-20260502021035010-6affaed2`. Codex dispatch took ~8 min and finished `completed-uncommitted` (sandbox blocked `git add`/`commit` — exact `feedback_executor_did_not_open_pr` pattern). Used `recover-commit.js --reason "codex finished implementation but sandbox blocked git add/commit step"` to commit/push/open PR (`commitSha 10d31f4`, `prCreated true`). R1 reviewer found a real contract gap (recovery-playbook paragraph too generic, missing 3-case decision tree the rubric explicitly required). R2 codex re-dispatch (~76 s) rewrote the paragraph as 3-case tree; R2 PASS clean. CI green. Squash-merged. **Net diff**: 6 files +470 lines (new `rebrand-evidence.js` 267 LOC + `rebrand-evidence.test.js` 196 LOC + cli-schema entry + cli-schema test + CLAUDE.md "Common Commands" entry + recovery-playbook decision tree). Sprint complete; next action: log entries.
