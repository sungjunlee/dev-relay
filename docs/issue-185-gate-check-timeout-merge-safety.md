# Issue 185 Gate-Check Timeout Merge Safety

## Summary

Issue #185 closes the HIGH merge-safety class surfaced by the codex post-merge challenge of `#166` / PR #184, merged as `c450588` probe 4. On that tree, `skills/relay-merge/scripts/gate-check.js:137-153` could time out on `.pr_number_stamp.lock`, re-read the manifest, and still return `git.pr_number: null`; `skills/relay-merge/scripts/review-gate.js:113` then accepted the unstamped manifest as LGTM because the merge gate never read `manifestData.git.pr_number`.

The fix keeps the audit-trail side of `#166` unchanged but splits the timeout policy by enforcement layer: audit-trail handling remains fail-safe, concurrent terminalization remains a fail-safe skip, and the merge gate now fails closed only when the timeout re-read is still non-terminal with `git.pr_number: null`. This is the same compliance-theater pattern as `#138` / `#155`, one layer deeper.

## Pattern-Break Rationale

`#166` already applied meta-rule 1 to the happy-path enforcement layers: layer A serialized the first-resolution stamp, and layer B deduped the audit event. `#185` applies that same rule recursively to the timeout fallthrough itself, because the timeout branch feeds two different downstream consumers with different safety requirements.

Memory rule 8 is mirrored below in full, and the complete 8-rule feedback file is committed at `memory/feedback_rubric_fail_closed.md` in this repo. The in-repo file is the authoritative tracked mirror; the orchestrator session keeps an equivalent persistent copy at `~/.claude/projects/-Users-sjlee-workspace-active-harness-stack-dev-relay/memory/feedback_rubric_fail_closed.md` as its session index. The two copies are kept in sync whenever a new rule is authored.

## Memory Rule 8 — Full Text (mirrored from orchestrator memory)

The full 8-rule feedback file is committed at `memory/feedback_rubric_fail_closed.md` at the repo root; an equivalent persistent copy lives in orchestrator-local memory at `~/.claude/projects/-Users-sjlee-workspace-active-harness-stack-dev-relay/memory/feedback_rubric_fail_closed.md` as the session index. The two copies are equivalent; future rules are authored into both at once. The rule 8 text is mirrored here so the lesson is discoverable directly from this issue mirror without leaving the docs tree.

**Timeout / contention-fallthrough policy split (2026-04-15, from codex post-merge challenge of merged #166/PR #184/`c450588`, probe 4):** lock or contention-fallthrough paths inside a multi-layer invariant must split their TIMEOUT POLICY by enforcement layer too — not just their happy-path logic. A unified "fail-safe on timeout" clause at the outer layer masks fail-safety breaks at the downstream gate.

**Why:** PR #184 (closes #166) applied meta-rule 1 (enforcement-layer split) correctly to the two HAPPY-PATH layers of gate-check's pr_number stamping — layer A (lock acquisition + write) and layer B (event-journal dedup) — but kept a UNIFIED timeout policy: on lock timeout, return the freshly read manifest and let gate-check continue. Codex's post-merge adversarial challenge probe 4 surfaced that the unified timeout policy was CORRECT for the audit-trail invariant (the next caller's layer B dedup handles late event emission so the audit stays clean) but WRONG for the merge-gate invariant: `evaluateReviewGate` at `review-gate.js:113` does not check `manifestData.git.pr_number`, so an unstamped manifest returned by the timeout path produced `{ status: "lgtm", readyToMerge: true }` — advancing the merge gate on a manifest that never received its first-resolution audit row. Same compliance-theater pattern as #138 rd5 / #155 rd1 (visible vs fail-closed): the unified outer-layer policy obscured a split-by-consumer inner-layer need. Filed and closed by #185.

**How to apply:** when authoring a rubric factor for a lock / contention-fallthrough path (O_EXCL + timeout, `Atomics.wait` + deadline, lockfile polling, similar), enumerate every DOWNSTREAM CONSUMER of the fallthrough output. For each consumer, ask: does this consumer require the same fail-policy the fallthrough itself chose? If any consumer requires a different policy (e.g., a merge gate requires fail-closed on a field the fallthrough makes no guarantee about, or an audit-trail consumer requires fail-safe where the fallthrough intended to fail-closed), split the rubric factor by downstream-consumer class and require separate targets for each. The fallthrough itself may be fail-safe OR fail-closed OR hybrid; the rubric must force the executor to choose per-consumer rather than adopt a single blanket policy. Generalizes beyond gate-check stamping: any lock-or-deadline-with-fallthrough that feeds multiple consumer layers applies. First application: #185's split of #166's unified fail-safe timeout into audit-trail (fail-safe, layer B) + merge-gate (fail-closed, layer A null-pr_number) + healthy-contention (unchanged) sub-policies.

## Rules Applied

- Rule 1: enforcement-layer split, applied recursively to the timeout branch instead of only to the lock-vs-journal happy path.
- Rule 3: end-to-end recovery is exercised with a real `gate-check.js` child process that fails on a stale lock, then succeeds after the operator clears the file.
- Rule 5: the cross-iteration STOP mechanism is the surfacing path here; this PR is the direct response to the HIGH class found after `#166` merged.
- Rule 7: the merge-gate invariant is fail-closed while the audit-trail invariant remains fail-safe, because the two consumers are not allowed to share one policy.
- Rule 8: timeout and contention fallthrough must be evaluated per downstream consumer, not per branch alone; the rule text is included in this round's evidence, and the full 8-rule file is committed at `memory/feedback_rubric_fail_closed.md` so the lesson ships inside the PR bundle.

## Fail-Safe-Vs-Fail-Closed Split

- Audit-trail, layer B, prior-event dedup: fail-safe. If the earlier process already appended `pr_number_stamped`, the current process does not duplicate it. This remains exactly as shipped in `#166`.
- Merge-gate, layer A timeout with `git.pr_number: null`: fail-closed. The timeout branch now re-reads once, returns early if a concurrent close/finalize already made the manifest terminal, and only throws when the fresh state is still non-terminal and unstamped so `main()` emits `manifest_resolution_failed` and exits 1.
- Healthy contention, lock acquired or peer finished during wait: unchanged. The timeout branch still succeeds when the fresh re-read finds a non-null `git.pr_number`, and the in-lock path still performs fresh-read, non-terminal recheck, write, dedup, and append without widening scope.

## Rendered Self-Review Grep Output

```text
$ grep -n "lockFd === null\|waitForPrNumberStampLock\|throw" skills/relay-merge/scripts/gate-check.js
120:function waitForPrNumberStampLock(lockPath) {
130:        throw error;
146:  lockFd = waitForPrNumberStampLock(lockPath);
147:  if (lockFd === null) {
161:    throw new Error(
176:    // without turning the race into a throw.
223:        throw error;

$ grep -n "isNonTerminalStateForPrStamp\|still-running holder\|clear it only after confirming" skills/relay-merge/scripts/gate-check.js
56:function isNonTerminalStateForPrStamp(state) {
154:    if (!isNonTerminalStateForPrStamp(freshRecord.data?.state)) {
163:      + "This may indicate a stale lock, peer crash, or a still-running holder on a slow filesystem. "
164:      + `Inspect ${JSON.stringify(lockPath)} and clear it only after confirming no active holder is still stamping. `
177:    if (!isNonTerminalStateForPrStamp(freshRecord.data?.state)) {

$ grep -n "\.pr_number_stamp\.lock" skills/relay-merge/scripts/gate-check.js
44:const PR_NUMBER_STAMP_LOCK_NAME = ".pr_number_stamp.lock";
162:      "gate-check: .pr_number_stamp.lock contention timeout left git.pr_number unset after a fresh re-read. "

$ grep -n "manifest_resolution_failed\|tryResolveManifestForPr" skills/relay-merge/scripts/gate-check.js
229:function tryResolveManifestForPr(prNumber, headRefName) {
284:    } else if (result.status === "manifest_resolution_failed") {
346:    const manifestRecord = tryResolveManifestForPr(PR_NUM, parsed.headRefName || null);
349:        status: "manifest_resolution_failed",
363:        status: "manifest_resolution_failed",

$ grep -n "^const .* = require" skills/relay-merge/scripts/gate-check.js
27:const fs = require("fs");
28:const path = require("path");
29:const { execFileSync } = require("child_process");
30:const { buildSkipComment, evaluateReviewGate } = require("./review-gate");
31:const { STATES, getRunDir, readManifest, writeManifest } = require("../../relay-dispatch/scripts/relay-manifest");
32:const { appendRunEvent, readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
33:const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");

$ git diff --name-only c450588..HEAD
docs/issue-166-gate-check-stamping-concurrency.md
docs/issue-185-gate-check-timeout-merge-safety.md
memory/feedback_rubric_fail_closed.md
skills/relay-merge/scripts/gate-check.js
skills/relay-merge/scripts/gate-check.test.js
```

## Call-Site Audit Recheck

The original `#166` audit claim still holds on this head: `gate-check.js` remains the only non-test producer of `pr_number_stamped`, and no new `git.pr_number = ...` stamping sites were introduced by `#185`. The timeout fix stays entirely inside the existing first-resolution stamping site rather than widening to sibling producers.

## Scope / Out Of Scope

- `skills/relay-merge/scripts/review-gate.js` — the absence of a `manifestData.git.pr_number` check is belt-and-suspenders territory; the upstream stamping contract is the correct enforcement point. Fixing here would be defense-in-depth but shadows the root cause.
- Lock timeout value (`PR_NUMBER_STAMP_LOCK_TIMEOUT_MS`) — tuning concern, separate issue.
- Stale-lock age-based auto-recovery — requires race-condition analysis for unlink-then-retry; separate issue.
- Layer B (journal dedup), non-terminal guard, healthy-contention path — all PASS in `#166`.
- `skills/relay-dispatch/scripts/relay-manifest.js` — state machine + `writeManifest` primitive correct as-is.
- `skills/relay-dispatch/scripts/relay-resolver.js` — `#156` / `#174` / `#177` containment complete; `#185` is orthogonal.
- `skills/relay-dispatch/scripts/relay-events.js` — `appendRunEvent` API unchanged.
- Producer output shapes (`reliability-report.js`, `probe-executor-env.js`) — Phase 0.2 / 0.3 freeze.
- `pr_number_stamped` event shape — unchanged.
- Sibling phase-0-follow-up issues (`#163`, `#160`, `#158`, `#161`, `#153`, `#152`, `#151`, `#150`) — tracked separately.
- Phase 1 items (`#141`, `#142`) — deferred pending observation window.

## Cross-Reference To Issue 166 Mirror

See [docs/issue-166-gate-check-stamping-concurrency.md](./issue-166-gate-check-stamping-concurrency.md) for the original layer-A / layer-B split from `#166`. Its unified timeout rationale is superseded by the three-way split documented here for `#185`.

## Prior Art

- `#138`: visible warning versus fail-closed enforcement was the original compliance-theater warning.
- `#155`: rule 1 first captured the need to split prompt-visible behavior from gate-state enforcement.
- `#166`: introduced the layer-A / layer-B stamping split that `#185` extends one layer deeper.
- `c450588`: the merge of PR #184 that shipped the unified timeout policy this PR closes.

## Round Discipline

Any edit that shifts `gate-check.js` line numbers, including the new timeout-branch throw or the new regression test reference comments, requires regenerating every pinned citation in this mirror as the last edit of the round. This follows the same discipline called out in `#174` round 4, `#177` round 3, `#139` round 2, `#176`, and `#166`: line-pinned docs are only trustworthy when refreshed from the final post-fix tree.

## Future-Iteration Warning

Do NOT re-collapse the audit-trail and merge-gate sub-policies into a single "fail-safe" clause. The unified timeout policy masked the HIGH class this PR closes; re-collapsing would reopen it.
