# Issue 166 Gate-Check Stamping Concurrency

## Summary

#166 closes a duplicate-event bug in `gate-check.js` first-resolution `pr_number` stamping. The manifest field write was already atomic via `writeManifest()`'s tmp+rename primitive at `skills/relay-dispatch/scripts/relay-manifest.js:337-344`; the race lived at the `appendFileSync`-based event append layer in `skills/relay-dispatch/scripts/relay-events.js:18-36`. The fix adds a filesystem mutex around the read-check-write-append sequence (layer A) plus a committed-journal dedup before append (layer B). Sibling phase-0 follow-up issues `#163`, `#160`, and `#158` remain tracked separately.

## Pattern-Break Rationale

This is a concurrency-containment fix within the write-once event contract introduced by `#149` first-resolution stamping. No new ladder rung is added: the work stays inside `gate-check.js`, reuses the existing manifest atomic write primitive, and applies the already-established rubric-authoring rules around enforcement-layer splits and call-site enumeration. No new meta-rule surfaces here; `memory/feedback_rubric_fail_closed.md` is not extended by this PR.

## Rules Applied

- Rule 1, enforcement-layer split: layer A serializes the read-modify-write branch with a run-local lock, and layer B dedupes `pr_number_stamped` against the committed journal. Fixing only the manifest write would have repeated the old compliance-theater mistake because the corruption lived in the append-only audit layer.
- Rule 3, end-to-end regression: the new regression spawns real `gate-check.js` child processes that share `RELAY_HOME` and the same fake PR payload, then asserts on committed `events.jsonl` contents. The pre-fix failure was verified out-of-band during dispatch round 1 on a scratch branch: rerunning this test against `gate-check.js:84-121` on `26c58fa` produced 3 duplicate `pr_number_stamped` rows. The checked-in harness exercises only the fixed `SCRIPT`.
- Rule 4, state-machine-axis applicability with scoped whitelist: the relay state machine is intentionally untouched because `#166` is not a bad transition bug. The defect sits below `validateTransition()` in a first-resolution write path that already converged at the manifest layer. The `#177` whitelist predicate is re-derived inline inside `gate-check.js` from `STATES` (already exported from `relay-manifest.js`) rather than imported from `relay-resolver.js`. The state machine itself is untouched; `relay-resolver.js` is untouched by the behavior change.
- Rule 4, inside-lock invariant preservation: `stampPrNumberUnderLock()` now re-applies the local `isNonTerminalStateForPrStamp()` whitelist after `readFreshManifestRecord()`. That keeps the caller's non-terminal resolver contract intact if `close-run` or `finalize-run` transitions the manifest during the bounded lock wait.
- Rule 6, call-site enumeration: every `pr_number_stamped` producer and every `git.pr_number` stamping path across `skills/relay-merge/`, `skills/relay-dispatch/`, and `skills/relay-review/` is classified below, with extra grep-only helper/read sites called out explicitly so there is no hidden sibling producer.
- Rule 7, fail-safe vs fail-closed: lock timeout and prior-event detection are treated as fail-safe concurrency degradation, so gate-check re-reads and continues. That is deliberately distinct from the fail-closed security-correctness posture used in `#148` / `#155` / `#174` / `#177`.

## Call-Site Audit Table

| Site | Field / Event | Pattern | Classification |
| --- | --- | --- | --- |
| `gate-check.js:130-218` (`stampPrNumberUnderLock()` + `tryResolveManifestForPr()`) | `git.pr_number` + `pr_number_stamped` | first-resolution stamping when field is null | **FIXED** — layer-A mutex + layer-B committed-journal dedup applied at the only first-resolution discover-and-fill site, and the fresh locked read now re-applies the non-terminal whitelist before stamping. |
| `finalize-run.js:293-300,359-366,373-380` | `merge_blocked` | per-attempt audit | **UNCHANGED — per-attempt audit**. Multiple rows are intentional because each blocked merge attempt is a separate audit fact. |
| `finalize-run.js:396-414` | `git.head_sha` + `merge_finalize` | merge-finalization write/audit | **UNCHANGED — single writer in practice**. Only one `finalize-run.js --run-id <id> --merge-method squash` invocation is expected per run; `gh pr merge` is the authoritative single action, and `fetchPrMergeState()` short-circuits once `MERGED` is observed. Cross-process concurrent finalize-run calls are not a supported workflow; file a separate issue if observed. |
| `finalize-run.js:439-448` | `cleanup_result` | per-cleanup attempt audit | **UNCHANGED — per-attempt audit**. Duplicate rows are intentional when cleanup is retried. |
| `review-runner.js:997-1005,1067-1073` | `git.pr_number` + `git.head_sha` | caller-provided pass-through | **UNCHANGED — single writer**. Review runner only persists the PR supplied by `--pr` or an already-resolved manifest; it does not discover-and-fill a missing PR from external state. |
| `review-runner.js:1189-1196,1305-1312,1394-1400` | `review_apply` | per-review invocation audit | **UNCHANGED — single writer in practice**. One reviewer process owns a given round application in normal workflow; concurrent review rounds on the same run would be a separate concurrency concern. Not a first-resolution discover-and-fill pattern. |
| `update-manifest-state.js:143-152` | `git.pr_number` / `git.head_sha` | explicit CLI setter | **UNCHANGED — single writer**. Values are caller-provided via flags; there is no concurrent discover-and-fill branch. |
| `dispatch.js:497-502` | `environment_drift` | resume-path audit | **UNCHANGED — single writer in practice**. One resume invocation emits this row in normal workflow; concurrent resumes on the same run would be a separate concurrency concern outside this PR's scope. Not a first-resolution discover-and-fill pattern. |
| `dispatch.js:542-548` | `rubric_grandfathered` | grandfather-only resume audit | **UNCHANGED — single writer in practice**. One grandfather-resume invocation emits this row in normal workflow; concurrent grandfather-resumes would be a separate concurrency concern. Not a first-resolution discover-and-fill pattern. |
| `dispatch.js:817-823,968-975` | `dispatch_start` / `dispatch_result` | dispatch lifecycle per invocation | **UNCHANGED — dispatch lifecycle events emit on the same per-invocation trace as their corresponding manifest creation or resume transition. The initial-dispatch concurrency concern (ms-granularity `run_id` collision under simultaneous initial dispatches on the same branch) is tracked separately at `#158` and is NOT folded into this PR. Resume dispatches share the concurrency concern noted on the `environment_drift` row above. Not a first-resolution discover-and-fill pattern.** |
| `close-run.js:98-115` | `close` + `cleanup_result` | close-run lifecycle audit | **UNCHANGED — single writer in practice**. One `close-run` invocation is expected per run. Concurrent double-close attempts would both validate the same pre-close state in memory, both `writeManifest()` to `CLOSED`, and could both emit; that is the same sibling concurrency concern as `environment_drift`, not a first-resolution discover-and-fill pattern. File a separate issue if observed. |
| `cleanup-worktrees.js:136-145` | `cleanup_result` | cleanup sweep audit | **UNCHANGED — per-attempt audit**. Each cleanup invocation intentionally records its own result row. |
| `relay-manifest.js:661-677` | `git.pr_number: null` init | manifest creation | **UNCHANGED — single writer**. Manifest creation is the only writer at initialization time; this is not a discover-and-fill path. |
| `relay-events.js:18-36` | generic `appendRunEvent()` | shared append primitive | **UNCHANGED — helper definition**. `#166` is fixed at the only write-once caller instead of changing global append semantics for every event producer. |
| `relay-resolver.js:66-70,297-300` | `git.pr_number` reads | read-only diagnostics/selectors | **UNCHANGED — read-only**. These sites render or compare stored PR values; they do not mutate manifests or emit `pr_number_stamped`. |
| `update-manifest-state.js:17,55` | `git.pr_number` help text | CLI usage string | **UNCHANGED — help text**. Grep surfaces these strings, but they are not producers. |

The sole first-resolution stamping site claim still holds on this head: `gate-check.js` is the ONLY path that reads `git.pr_number === null`, discovers the PR from external state, writes it back, and emits a corresponding audit row - the pattern that defines `#166`'s bug class. The siblings above may or may not have separate concurrency concerns under concurrent cross-process invocation, but none of them match that first-resolution discover-and-fill pattern.

## Rendered Self-Review Grep

```text
$ grep -n "pr_number_stamped" skills/relay-merge/scripts/gate-check.js
171:    // regression cannot emit duplicate first-resolution pr_number_stamped events.
173:      .some((entry) => entry.event === "pr_number_stamped");
177:        event: "pr_number_stamped",

$ grep -rn "pr_number_stamped" skills/ | grep -v "\.test\.js"
skills/relay-merge/scripts/gate-check.js:171:    // regression cannot emit duplicate first-resolution pr_number_stamped events.
skills/relay-merge/scripts/gate-check.js:173:      .some((entry) => entry.event === "pr_number_stamped");
skills/relay-merge/scripts/gate-check.js:177:        event: "pr_number_stamped",

$ grep -nE "git\.pr_number" skills/relay-merge/scripts/gate-check.js
182:        reason: `Stamped git.pr_number=${numericPrNumber} during gate-check PR resolution`,

$ grep -n "openSync\|\.lock\|readRunEvents" skills/relay-merge/scripts/gate-check.js
32:const { appendRunEvent, readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
35:const PR_NUMBER_STAMP_LOCK_NAME = ".pr_number_stamp.lock";
118:      return fs.openSync(lockPath, "wx");
172:    const alreadyStamped = readRunEvents(repoRoot, updatedData.run_id)

$ grep -n "appendRunEvent" skills/relay-merge/scripts/gate-check.js
32:const { appendRunEvent, readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
176:      appendRunEvent(repoRoot, updatedData.run_id, {

$ grep -n "pr_number_stamped" skills/relay-dispatch/scripts/reliability-report.js || echo "(no consumer count-site — report keys on run_id)"
(no consumer count-site — report keys on run_id)

$ grep -n "^const .* = require" skills/relay-merge/scripts/gate-check.js
27:const fs = require("fs");
28:const path = require("path");
29:const { execFileSync } = require("child_process");
30:const { buildSkipComment, evaluateReviewGate } = require("./review-gate");
31:const { STATES, getRunDir, readManifest, writeManifest } = require("../../relay-dispatch/scripts/relay-manifest");
32:const { appendRunEvent, readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
33:const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");

$ grep -n "isNonTerminalStateForPrStamp\\|NON_TERMINAL_STATES_FOR_PR_STAMP" skills/relay-merge/scripts/gate-check.js
43:const NON_TERMINAL_STATES_FOR_PR_STAMP = new Set(
47:function isNonTerminalStateForPrStamp(state) {
48:  return NON_TERMINAL_STATES_FOR_PR_STAMP.has(state);
152:    if (!isNonTerminalStateForPrStamp(freshRecord.data?.state)) {

$ grep -n "isNonTerminalState" skills/relay-merge/scripts/gate-check.js
47:function isNonTerminalStateForPrStamp(state) {
152:    if (!isNonTerminalStateForPrStamp(freshRecord.data?.state)) {

$ grep -n "isNonTerminalState" skills/relay-dispatch/scripts/relay-resolver.js
88:function isNonTerminalState(state) {
100:  return records.filter((record) => isNonTerminalState(record?.data?.state));
113:    // to !isNonTerminalState(state) (fail-closed on unknown/tampered state values). Escalated stays
116:    if (excludeTerminal && !isNonTerminalState(record?.data?.state)) {
157:  return isNonTerminalState(record?.data?.state)

$ grep -n "relay-resolver" skills/relay-merge/scripts/gate-check.js
33:const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");
42:// and avoid widening relay-resolver.js's public API.
```

## Scope / Out Of Scope

- `skills/relay-dispatch/scripts/relay-manifest.js` — state machine (`STATES`, `ALLOWED_TRANSITIONS`, `validateTransition`) and `writeManifest` atomic primitive are correct as-is. The bug is at the event-journal layer, not the state machine.
- `skills/relay-dispatch/scripts/relay-resolver.js` — `#156` / `#174` / `#177` containment fixes are complete; `#166` is orthogonal and does not touch this file.
- `skills/relay-dispatch/scripts/dispatch.js`, `skills/relay-review/scripts/review-runner.js`, `skills/relay-merge/scripts/finalize-run.js`, `skills/relay-dispatch/scripts/close-run.js` — all classified UNCHANGED in the audit table; do not touch.
- `skills/relay-dispatch/scripts/reliability-report.js`, `skills/relay-plan/scripts/probe-executor-env.js` — Phase 0.2 / 0.3 producer freeze per `#139` / `#140`; output shapes stay untouched. `pr_number_stamped` keeps the same event name, fields, and field order.
- `#163` — rubric fail-closed recovery-path dead (`dispatch.js` requires `state=changes_requested`; `review-runner` leaves state at `review_pending`). Different failure mode; tracked separately.
- `#160` — `paths.repo_root` / `paths.worktree` trust-root sibling validation. Path-interpolation domain; `pr_number` is numeric.
- `#158` — run-id collision under rapid re-dispatch. Different code path (`createRunId` in `relay-manifest.js`); tracked separately.
- `#161`, `#153`, `#152`, `#151`, `#150` — `phase-0-follow-up` deferred.
- `#141` (Rejection Log), `#142` (TDD mode) — Phase 1 items deferred pending the 2-week observation window (tentative re-evaluation `~2026-04-28` per `memory/project_phase1_observation_gate.md`).
- Any new concurrency bug discovered in a sibling stamping site should be filed separately instead of folded into this PR.

## Numeric-Field-No-Trust-Root-Sweep Note

`git.pr_number` is a non-negative numeric field, not a path-bearing trust root. Unlike `run_id`, `paths.repo_root`, or `paths.worktree`, it does not participate in path interpolation, directory selection, or filesystem escape risk. The `#156` / `#160` trust-root sibling sweep therefore does not apply here, and this omission is deliberate so a future iteration does not file a redundant follow-up.

## Fail-Safe-Vs-Fail-Closed Rationale

**Note (2026-04-15, superseding)**: this section's unified fail-safe timeout rationale is split by `#185` / PR #186 into (a) audit-trail fail-safe (layer B, unchanged), (b) merge-gate fail-closed (layer A timeout with `git.pr_number: null` after a fresh re-read), and (c) healthy-contention unchanged; see [docs/issue-185-gate-check-timeout-merge-safety.md](./issue-185-gate-check-timeout-merge-safety.md) for the full split policy and the compliance-theater prior-art citation (`#138` / `#155`), and read the warning below as applying to the pre-split uniform policy rather than the post-`#185` merge-gate throw condition.
When the layer-A lock times out or layer-B dedup sees an already-committed `pr_number_stamped` row, the stamping branch is skipped cleanly and gate-check continues with a freshly read manifest. That is fail-safe behavior for legitimate concurrent CI reruns: the audit trail stays clean, and merge gating still evaluates against the latest committed state. It is intentionally different from fail-closed security fixes such as `#148`, `#155`, `#174`, and `#177`, which must refuse to proceed. Future iterations should not tighten this concurrency skip into a throw.

## Prior Art

- PR #164 (`#149`, merged `955cd6e`): introduced the first-resolution `git.pr_number` stamping contract that `#166` now hardens for concurrent gate-check runs.
- PR #159 (`#156`): added `run_id` validation and established the adjacent containment vocabulary for manifest-backed relay state.
- PR #183 (`#176`, merged `26c58fa`): most recent containment-at-side-path template and the mirror structure copied here.

## Round Discipline

Any edit that shifts `gate-check.js` line numbers, including the new builtin imports, the `readRunEvents` import, or the `stampPrNumberUnderLock()` helper, requires regenerating every pinned reference in this mirror as the last edit of the round. This follows the same round-final discipline called out in `#174` round 4, `#177` round 3, `#139` round 2, and `#176`: line-pinned docs are only trustworthy when refreshed from the final post-fix tree.
