# Issue 176 Cleanup-Worktrees Raw run_id

## Summary

#176 closes a containment-at-side-path leak in `cleanup-worktrees.js` by reusing the `safeFormatRunId()` helper introduced by PR #175 (`#174`). The two raw `data.run_id` operator-emission sites at `skills/relay-dispatch/scripts/cleanup-worktrees.js:89` (`baseInfo.runId`) and `:98` (`baseInfo.closeCommand`) now route through the shared validator-backed formatter instead of duplicating an inline fallback. Sibling trust roots `paths.repo_root` and `paths.worktree` are explicitly deferred to `#160`.

## Pattern-Break Rationale

This is a containment-at-side-path fix within the already-established `#156` / `#174` / `#177` pattern, not a new ladder rung. The helper already existed, the basename fallback contract already existed, and the issue was that `cleanup-worktrees.js` had drifted from that contract on an operator-facing side path. No new meta-rule surfaces here; `memory/feedback_rubric_fail_closed.md` is not extended by this PR.

## Rules Applied

- Rule 1, enforcement-layer split + trust-root sibling audit: the fix stays on the render path only, while explicitly deferring sibling trust roots `paths.repo_root` / `paths.worktree` to `#160`.
- Rule 3, recovery-path end-to-end regression: the new CLI regression exercises real JSON output and text output so the operator-facing leak is covered end-to-end.
- Rule 6, call-site enumeration: every raw `run_id` emission site in `skills/relay-dispatch/scripts/` is enumerated below and classified as fixed, exported, or intentionally unchanged.
- Rule 7, fail-closed discipline: the render path uses the validator-backed `safeFormatRunId()` fallback instead of re-emitting raw manifest data, while the write-side `appendRunEvent()` path remains fail-closed upstream.

## Call-Site Audit Table

| Site | Delta | Rationale |
| --- | --- | --- |
| `cleanup-worktrees.js:89` | **FIXED** | `data.run_id \|\| path.basename(...)` became `safeFormatRunId({ manifestPath, data })`, computed once as `runId` and reused. |
| `cleanup-worktrees.js:98` | **FIXED** | `closeCommand` now uses the same `runId` variable, preserving the `JSON.stringify(...)` wrapper around `--run-id`. |
| `cleanup-worktrees.js:136` | **UNCHANGED — fail-closed upstream** | `cleanupResult.updatedData.run_id` feeds `appendRunEvent()`; that path hits `ensureRunLayout()` -> `getRunDir()` -> `requireValidRunId()` in `relay-manifest.js`, so tampered values throw before any write-side effect. |
| `close-run.js:98` | **UNCHANGED — resolver-validated** | `updated.run_id` descends from `resolveManifestRecord()` at `close-run.js:64`, which validates manifest `run_id` via `validateManifestRecordRunId()` before returning. |
| `close-run.js:106` | **UNCHANGED — resolver-validated** | Same descent as `:98`; event emission stays behind resolver validation. |
| `close-run.js:120` | **UNCHANGED — resolver-validated** | Same descent as `:98`; JSON result rendering stays behind resolver validation. |
| `dispatch.js:454` | **UNCHANGED — resolver-validated** | `manifest.run_id` descends from `resolveManifestRecord()` at `dispatch.js:444`; resume mode inherits the resolver validation contract. |
| `relay-resolver.js:51` (`formatRunId`) | **UNCHANGED — happy-path renderer** | Inline comment documents that raw stored `run_id` remains available only for validated happy-path rendering; error builders use `safeFormatRunId()`. |
| `relay-resolver.js:57` (`safeFormatRunId`) | **EXPORTED** | The helper remains single-sourced and is now exported via `module.exports` at `relay-resolver.js:480-486` for `cleanup-worktrees.js` reuse. |
| `reliability-report.js:89/93/97, 207-214, 292-301, 387/391, 441/445` | **UNCHANGED — event-journal domain** | These uses key aggregate metrics by `event.run_id` / `manifest.data.run_id`; they do not emit per-run operator recovery commands, and the write-side journal path is already validated by `ensureRunLayout()`. |

`grep -nE "\\bdata\\.run_id\\b|\\bdata\\?\\.run_id\\b|\\bmanifest\\.run_id\\b|\\bupdated\\.run_id\\b|\\bupdatedData\\.run_id\\b" skills/relay-dispatch/scripts/*.js | grep -v "\\.test\\.js"` also matches non-emission validator/selector sites at `relay-manifest.js:396` and `relay-resolver.js:252,318`; those are intentionally omitted from the table because they validate or compare `run_id` rather than render it into operator-facing output.

## Rendered Self-Review Grep

```text
$ grep -n "safeFormatRunId" skills/relay-dispatch/scripts/cleanup-worktrees.js
25:const { safeFormatRunId } = require("./relay-resolver");
87:    // safeFormatRunId falls back to the manifest basename on tampered run_id so cleanup still
89:    const runId = safeFormatRunId({ manifestPath, data });

$ grep -n "safeFormatRunId" skills/relay-dispatch/scripts/relay-resolver.js
53:  // Error builders must use safeFormatRunId so tampered manifests cannot echo unsafe values (#171/#174).
57:function safeFormatRunId(record) {
70:    return `${safeFormatRunId(record)} (state=${state}, pr=${storedPr})`;
223:  const runId = safeFormatRunId(record);
305:    `The terminal sibling ${JSON.stringify(safeFormatRunId(terminalCandidate))} is already ${terminalState}, ` +
307:    `The ${freshState} sibling ${JSON.stringify(safeFormatRunId(freshCandidate))} does not carry the caller PR. ` +
486:  safeFormatRunId,

$ grep -n "module.exports" skills/relay-dispatch/scripts/relay-resolver.js -A 10
480:module.exports = {
481-  filterByBranch,
482-  filterByPr,
483-  findManifestByRunId,
484-  hasStoredPrNumber,
485-  resolveManifestRecord,
486-  safeFormatRunId,
487-};

$ grep -nE "data\.run_id\s*\|\|" skills/relay-dispatch/scripts/cleanup-worktrees.js

$ grep -nE "\bdata\.run_id\b" skills/relay-dispatch/scripts/cleanup-worktrees.js

$ grep -nE "\bdata\.run_id\b|\bdata\?\.run_id\b|\bmanifest\.run_id\b|\bupdated\.run_id\b|\bupdatedData\.run_id\b" skills/relay-dispatch/scripts/*.js | grep -v "\.test\.js"
skills/relay-dispatch/scripts/cleanup-worktrees.js:136:      appendRunEvent(repoRoot, cleanupResult.updatedData.run_id, {
skills/relay-dispatch/scripts/close-run.js:98:    appendRunEvent(repoRoot, updated.run_id, {
skills/relay-dispatch/scripts/close-run.js:106:    appendRunEvent(repoRoot, updated.run_id, {
skills/relay-dispatch/scripts/close-run.js:120:    runId: updated.run_id,
skills/relay-dispatch/scripts/dispatch.js:454:    runId = manifest.run_id || runId;
skills/relay-dispatch/scripts/relay-manifest.js:396:    : data?.run_id;
skills/relay-dispatch/scripts/relay-resolver.js:54:  return record?.data?.run_id || formatManifestBasename(record);
skills/relay-dispatch/scripts/relay-resolver.js:58:  const validation = validateRunId(record?.data?.run_id);
skills/relay-dispatch/scripts/relay-resolver.js:252:  const validation = validateRunId(record?.data?.run_id);
skills/relay-dispatch/scripts/relay-resolver.js:318:      data?.run_id === normalizedRunId
skills/relay-dispatch/scripts/reliability-report.js:207:      .filter((manifest) => manifest?.data?.run_id)
skills/relay-dispatch/scripts/reliability-report.js:208:      .map((manifest) => [manifest.data.run_id, manifest.data])
skills/relay-dispatch/scripts/reliability-report.js:387:    reviewRuns.set(manifest.data.run_id, Number(manifest.data.review?.max_rounds || 20));
skills/relay-dispatch/scripts/reliability-report.js:441:        .map(({ data }) => data?.run_id)
```

## Scope / Out Of Scope

- `paths.repo_root` / `paths.worktree` stay out of scope and remain tracked at `#160`; they are sibling trust roots at the same manifest-schema level, but folding them into this side-path renderer fix would exceed M-size.
- `reliability-report.js` event-journal consumption stays out of scope; it consumes validated write-side data for aggregate metrics and does not emit per-run operator command strings.
- `relay-resolver.js` `formatRunId()` stays raw by design for validated happy-path contexts; this PR only exports and reuses `safeFormatRunId()`.
- `relay-events.js` stays out of scope because it already validates via `ensureRunLayout()` on write.
- Any rubric-structure change in `relay-plan/SKILL.md` stays out of scope; Phase 0 "Wire What Exists" is complete as of `#140`.
- Phase 1 items `#141` (Rejection Log) and `#142` (TDD mode) remain deferred pending the observation window in `memory/project_phase1_observation_gate.md`.
- `phase-0-follow-up` siblings `#166`, `#163`, `#161`, `#158`, `#153`, `#152`, `#151`, and `#150` remain tracked separately and untouched here.
- Any newly discovered edge case that would require changing `relay-manifest.js` or expanding resolver invariants beyond exporting `safeFormatRunId()` stays out of scope for this PR and should be filed separately rather than folded in.

## Prior Art

- PR #159 (`#156`): added the `run_id` validator and established the single-path-segment trust-root contract.
- PR #175 (`#174`): added `safeFormatRunId()` and routed resolver error builders through safe candidate rendering so tampered manifests do not echo unsafe `run_id` values.
- PR #178 (`#177`): applied fail-closed state validation at resolver exclusion sites and documented the current meta-rule stack, including this issue as an explicit follow-up.

## Round Discipline

Any edit that shifts `cleanup-worktrees.js` line numbers, including the import that moved the leak sites from `:88/:94` to `:89/:98`, requires regenerating every pinned source reference in this mirror as the last edit of the round. This follows the same discipline called out in PR #175 round 4, PR #178 round 3, and PR #140 round 2: line-pinned docs are only trustworthy when refreshed from the final post-fix tree.

## Fallback-Is-Defensive Rationale

`safeFormatRunId()` falls back to the manifest filename basename on tampered `run_id` instead of throwing because `cleanup-worktrees` must continue enumerating stale manifests even when one manifest is malformed. The basename lives under the `listManifestPaths()` directory filter inside relay home, so the fallback keeps enumeration bounded to the relay-owned filesystem scope, while `JSON.stringify()` still blocks shell injection at the `closeCommand` site.
