---
milestone: Fleet Hygiene & Reliability
status: completed
started: 2026-07-09
due: TBD
objectives: []
component: "fleet-orchestration"
---

# fleet-hygiene-reliability

## Goal
Epic #872 plus the two highest-value reliability bugs: pre-manifest dispatch failures become diagnosable and retryable under the same fleet id, fleet state becomes visible without filesystem archaeology, the linked-worktree basename seam stops bricking review-runner, and the advisory lane starts yielding findings instead of silently degrading.

## Plan

### Batch 1 — disjoint surfaces, fully parallel (3 leaves)

- [x] #857 dispatch from a named linked worktree creates relay worktree with mismatched basename — MERGED by other session (PR #877, run `...c48a889a`), 2026-07-09.
- [x] #850 reviewer adapters: lenient JSON extraction — MERGED by other session (PR #875) 2026-07-10. Follow-up data point recorded on the issue: opencode advisory lane still yields empty stdout in rounds while the standalone probe succeeds (env/prompt-size class).
- [x] #869 relay-fleet: persist pre-manifest dispatch failure cause — MERGED (PR #874, run `...03ce75b4`, fleet-hygiene-w1 `closed`), 2026-07-09. R1 P2 (preserve dispatch JSON failure errors in last_error) fixed in R2 PASS.

### Batch 2 — blocked by Batch 1 (#870 shares relay-fleet.js with #869), 3 leaves parallel

- [x] #870 relay-fleet: overwrite protection allows replacing never-dispatched children — MERGED (PR #878) 2026-07-10, 11 rounds. Whitelist narrowed twice by DC amendment (rename-only, then fresh-refs-only) to kill concurrency classes at spec level; lock crash-safety hardened; R8/R10 were procedural-only (threads, CI in-progress).
- [x] #863 recover-state: whitelist `merge_blocked → ready_to_merge` — MERGED (PR #880) 2026-07-10. Timeout salvage: total_timeout at final gate under 3-codex load → orchestrator gate verify (969 pass) → two-hop recover-state + recover-commit; R1 3 findings (validated-transition bypass P1) → R2 PASS.
- [x] #862 Diet relay/references/batch-mode.md — MERGED (PR #879) 2026-07-10, 10 rounds. Review rounds surfaced REAL tooling gaps each time (unsupported transitions, drive review-loop skip semantics, inter-hop window) → recovery section now documents the verified two-hop whitelist path + interruption-safety guarantee; #889 filed for the one-hop.

### Batch 3 — blocked by Batch 2 (#871 shares relay-fleet.js with #870)

- [x] #871 relay-fleet: `--status` without `--fleet-id` lists all fleets — MERGED (PR #892) 2026-07-10, R1 PASS bull's-eye; fleet-hygiene-w3 `closed` with zero interventions (drive #2 did review→merge→close in one run).
- [x] OPS: stale-fleet sweep DONE 2026-07-10 — 12 pure-rot fleets driven to `closed` (12/12, one drive re-run each, zero interventions); 6 junk manifests deleted (5× fleet-825 + baby-ops codex-variant, same storm class); 2 fleets left open on purpose (beopjalal ai-metadata-batch1: 2 ready_to_merge PRs; dear-scene m7-wave1: 2 dead dispatched runs) — real work, owner decision. Recorded on epic #872.

### Held — not dispatchable this sprint (no checkbox: must not surface in next_batch)

- #861 sunset deprecated relay-fleet entry points (`--resume` alias, `--review`/merge-queue.js as primary) — HELD on the one-release sunset boundary after #842; also shares relay-fleet.js AND merge-queue.js with #869/#870/#871/#850, so it must come after all of them regardless. Dispatch as a post-sprint single once the boundary passes.

## Running Context

- **Batch = wave** (dev-backlog #267 convention): items within a batch are mutually parallel-safe (verified disjoint file surfaces above); batches are ordered by the `relay-fleet.js` chain #869 → #870 → #871. One fleet per batch (`skills/relay-fleet/references/sprint-to-leaves.md` recipe); suggested fleet ids `fleet-hygiene-w1/w2/w3`.
- Reviewer: primary codex. Advisory lane (post-#867 profiles) currently yields ZERO with glm-5.2 (#850) — once Batch 1 lands #850, enable `--advisory-reviewer` with `opencode-go/glm-5.2` for Batch 2/3 reviews as live validation of the fix.
- Every relay-fleet.js leaf runs `node --test --test-concurrency=1 tests/relay-fleet/scripts/*.test.js` serialized (#816 convention); full-suite final gate once before commit (dispatch timeout 5400 when the prerequisite is the full suite).
- Base freshness is now automatic: #866 (worktrees branch from `origin/<base>`) + #865 (remote-valid base names) — no detach-HEAD dance needed when dispatching from the orca workspace.
- Sprint writes (`[ ]→[~]→[x]`, Progress) are orchestrator-single-writer; fleet children never touch `backlog/`.
- #870's DC must pin the accepted-path atomicity (manifest children + persisted-leaves store updated together) and byte-preserve the fail-closed error for children WITH a run_id (behavior-matrix rubric, both rows).
- #857 evidence run for the reproduction fixture: `issue-306-20260708134824707-8762967a` (workaround was `git worktree move` + manifest path edit — the test should prove that dance is no longer needed).

## Progress

### 2026-07-10 (SPRINT COMPLETE — all 7 plan items + ops sweep done)
- **#871 merged (PR #892), R1 PASS bull's-eye; fleet-hygiene-w3 `closed`** — the second drive invocation ran review→merge→close with zero interventions, the clean end-to-end demonstration of drive-by-default.
- **Ops sweep**: 12 rot fleets → `closed` (12/12 single re-runs), 6 junk manifests deleted, 2 real-work fleets reported to owners (beopjalal ai-metadata-batch1, dear-scene m7-wave1). Global census: only those 2 remain non-closed.
- Sprint tally: 7 issues closed (#857/#850 other session; #869/#863/#870/#862/#871 this session), 7 PRs merged, epic #872 fully done. Byproducts: #876 (premature reconcile, priority:high, + SkyComputerUseClient pgid root-cause), #889 (one-hop merge_blocked→review_pending), #850 comment (opencode empty-stdout), sprint status → completed. Held: #861 (sunset, next release boundary).

### 2026-07-10 (Batch 2 closed: fleet-hygiene-w2 3/3 merged)
- **fleet-hygiene-w2 `closed`** after an overnight gauntlet: #863 (PR #880, 2R + timeout salvage), #870 (PR #878, 11R), #862 (PR #879, 10R). Drive exit noted `high_review_rounds` for the latter two — accurate.
- **Environment failures crossed, all recovered**: machine-wide system-DNS outage (~9h, resolver config gone; browser DoH masked it) → session restart; `/tmp` wipe killed DC anchors mid-run → restored from runDir authoritative copies (#863's DC re-authored from context; lesson matches the other session's "/tmp DC anchors die on reboot"); codex CLI too old for OpenAI's `gpt-5.6-sol` rollout → `codex update` to 0.144.1; mass cross-session background-task kills → switched to `dispatch --detach` + Monitor-tool watches; review-runner TLS/network interruptions → foreground re-runs.
- **New tooling gaps surfaced and filed/annotated**: #889 (merge_blocked→review_pending one-hop whitelist — #862's rounds proved the gap), #876 comment (lease pgid false-alive: lingering `SkyComputerUseClient` turn-ended notifier keeps executor pgid alive → reconcile "running" for a dead run + `executor_group_unsettled` bookkeeping; manual kill unblocked), #850 comment (opencode advisory lane: empty stdout in rounds while standalone probe succeeds — env/prompt-size class, not model format).
- **Process notes**: #870 R3 flip-flop owner-override (3 distinct gaps ≠ thrash); two DC amendments on #870 (rename-only → fresh-refs-only) removed concurrency classes at spec level — subtraction beat runtime defense; #862's advisory-vs-contract mistake (my prompt Context contradicted DC) cost R1; same-HEAD dual-flag + PR-body-evidence recovery used 3× for procedural-only rounds (thread resolution, CI completion).

### 2026-07-09 (Batch 1 launched; cross-session split discovered)
- **Cross-session collision detected before dispatch**: another live session dispatched #857 (run `...c48a889a`, 20:42 KST) and #850 (run `...fab4c9fe`, 20:37 KST) minutes before this session's fan-out — found via fresh `/tmp/rubric-857.yaml` mtime + run-manifest scan. Split adopted instead of duplicate dispatch (parallel-session PR collision playbook): other session owns #857/#850; this session owns #869 via `fleet-hygiene-w1` (fleet-of-1) and remains sprint-file single writer. The other session also resumed #783 (paused route-config sprint item — consistent with the unblock note left there).
- Planning artifacts for #869: `/tmp/{dispatch,rubric,done-criteria}-869.md|.yaml`; leaves file `/tmp/fleet-hygiene-w1-leaves.json`. Anchor notes: the issue's `parseJsonObject` reuse advice for sibling #850 was found shape-mismatched (line-based parse cannot extract multi-line JSON after prose) — recorded in this session's `/tmp/done-criteria-850.md` for reference, though the other session's plan governs that run.
- Dispatch root: `~/.codex/worktrees/cfde/dev-relay` (canonical basename, main == origin/main) — avoids the #857 seam for our own dispatches; base=main by checkout.
- **Live incident → #876 (priority:high)**: drive #1 reconciled the #869 dispatch (row 4 `dead_with_result_or_work`) while supervisor 56844 + codex 58488 were ALIVE (elapsed 1274s of 3600s) — premature recover-commit `c32b54f` + PR #874 from a mid-work snapshot, and review preflight then hard-failed on missing execution-evidence.json (completion path bypassed). Luck: executor was at its final gate, so the snapshot IS the complete implementation (its audit + orchestrator's live gate re-run both 58 pass/0 fail). Recovery: authored evidence post-hoc (`recorded_by: orchestrator-recovery`), re-ran the same drive command → review proceeding. Two-death-signals rule now applies to reconcile trust as well as operator probes.
