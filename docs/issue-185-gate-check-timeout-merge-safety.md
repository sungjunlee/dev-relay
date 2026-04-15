# Issue 185 Gate-Check Timeout Merge Safety

## Summary

Issue #185 closes the HIGH merge-safety class surfaced by the codex post-merge challenge of `#166` / PR #184, merged as `c450588` probe 4. On that tree, `skills/relay-merge/scripts/gate-check.js:137-153` could time out on `.pr_number_stamp.lock`, re-read the manifest, and still return `git.pr_number: null`; `skills/relay-merge/scripts/review-gate.js:113` then accepted the unstamped manifest as LGTM because the merge gate never read `manifestData.git.pr_number`.

The fix keeps the audit-trail side of `#166` unchanged but splits the timeout policy by enforcement layer: audit-trail handling remains fail-safe, while the merge gate now fails closed when the timeout re-read still sees `git.pr_number: null`. This is the same compliance-theater pattern as `#138` / `#155`, one layer deeper.

## Pattern-Break Rationale

`#166` already applied meta-rule 1 to the happy-path enforcement layers: layer A serialized the first-resolution stamp, and layer B deduped the audit event. `#185` applies that same rule recursively to the timeout fallthrough itself, because the timeout branch feeds two different downstream consumers with different safety requirements.

The intended new rule 8 for `~/.claude/projects/-Users-sjlee-workspace-active-harness-stack-dev-relay/memory/feedback_rubric_fail_closed.md` captures that lesson explicitly: timeout and contention-fallthrough policy must be split by downstream consumer class, not treated as one blanket "fail-safe" clause. The canonical memory file sits outside this worktree's writable boundary, so this mirror records the rule-8 rationale even though the file itself could not be edited from this sandboxed session.

## Rules Applied

- Rule 1: enforcement-layer split, applied recursively to the timeout branch instead of only to the lock-vs-journal happy path.
- Rule 3: end-to-end recovery is exercised with a real `gate-check.js` child process that fails on a stale lock, then succeeds after the operator clears the file.
- Rule 5: the cross-iteration STOP mechanism is the surfacing path here; this PR is the direct response to the HIGH class found after `#166` merged.
- Rule 7: the merge-gate invariant is fail-closed while the audit-trail invariant remains fail-safe, because the two consumers are not allowed to share one policy.
- Rule 8: timeout and contention fallthrough must be evaluated per downstream consumer, not per branch alone; the rule text is included in this round's evidence even though the canonical memory file could not be updated from this sandboxed worktree.

## Fail-Safe-Vs-Fail-Closed Split

- Audit-trail, layer B, prior-event dedup: fail-safe. If the earlier process already appended `pr_number_stamped`, the current process does not duplicate it. This remains exactly as shipped in `#166`.
- Merge-gate, layer A timeout with `git.pr_number: null`: fail-closed. The timeout branch now re-reads once, and if the manifest is still unstamped it throws an actionable error so `main()` emits `manifest_resolution_failed` and exits 1.
- Healthy contention, lock acquired or peer finished during wait: unchanged. The timeout branch still succeeds when the fresh re-read finds a non-null `git.pr_number`, and the in-lock path still performs fresh-read, non-terminal recheck, write, dedup, and append without widening scope.

## Rendered Self-Review Grep Output

```text
$ grep -n "lockFd === null\|waitForPrNumberStampLock\|throw" skills/relay-merge/scripts/gate-check.js
111:function waitForPrNumberStampLock(lockPath) {
121:        throw error;
137:  lockFd = waitForPrNumberStampLock(lockPath);
138:  if (lockFd === null) {
149:    throw new Error(
164:    // without turning the race into a throw.
211:        throw error;

$ grep -n "\.pr_number_stamp\.lock" skills/relay-merge/scripts/gate-check.js
35:const PR_NUMBER_STAMP_LOCK_NAME = ".pr_number_stamp.lock";
150:      "gate-check: .pr_number_stamp.lock contention timeout left git.pr_number unset after a fresh re-read. "
152:      + `Clear the .pr_number_stamp.lock file and retry: rm ${JSON.stringify(lockPath)}. `

$ grep -n "manifest_resolution_failed\|tryResolveManifestForPr" skills/relay-merge/scripts/gate-check.js
217:function tryResolveManifestForPr(prNumber, headRefName) {
272:    } else if (result.status === "manifest_resolution_failed") {
334:    const manifestRecord = tryResolveManifestForPr(PR_NUM, parsed.headRefName || null);
337:        status: "manifest_resolution_failed",
351:        status: "manifest_resolution_failed",

$ grep -n "^const .* = require" skills/relay-merge/scripts/gate-check.js
27:const fs = require("fs");
28:const path = require("path");
29:const { execFileSync } = require("child_process");
30:const { buildSkipComment, evaluateReviewGate } = require("./review-gate");
31:const { STATES, getRunDir, readManifest, writeManifest } = require("../../relay-dispatch/scripts/relay-manifest");
32:const { appendRunEvent, readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
33:const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");

$ git diff --name-only c450588..HEAD
docs/issue-185-gate-check-timeout-merge-safety.md
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

See [docs/issue-166-gate-check-stamping-concurrency.md](/Users/sjlee/.relay/worktrees/de339e07/dev-relay/docs/issue-166-gate-check-stamping-concurrency.md) for the original layer-A / layer-B split from `#166`. Its unified timeout rationale is superseded by the three-way split documented here for `#185`.

## Prior Art

- `#138`: visible warning versus fail-closed enforcement was the original compliance-theater warning.
- `#155`: rule 1 first captured the need to split prompt-visible behavior from gate-state enforcement.
- `#166`: introduced the layer-A / layer-B stamping split that `#185` extends one layer deeper.
- `c450588`: the merge of PR #184 that shipped the unified timeout policy this PR closes.

## Round Discipline

Any edit that shifts `gate-check.js` line numbers, including the new timeout-branch throw or the new regression test reference comments, requires regenerating every pinned citation in this mirror as the last edit of the round. This follows the same discipline called out in `#174` round 4, `#177` round 3, `#139` round 2, `#176`, and `#166`: line-pinned docs are only trustworthy when refreshed from the final post-fix tree.

## Future-Iteration Warning

Do NOT re-collapse the audit-trail and merge-gate sub-policies into a single "fail-safe" clause. The unified timeout policy masked the HIGH class this PR closes; re-collapsing would reopen it.
