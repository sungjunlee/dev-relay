# Issue #189 — Review Runner Decomposition

## Summary

`skills/relay-review/scripts/review-runner.js` is now an orchestration facade over eight staged helpers in [`skills/relay-review/scripts/review-runner/`](../skills/relay-review/scripts/review-runner/), plus a tiny shared [`common.js`](../skills/relay-review/scripts/review-runner/common.js) for CLI/file helpers. The public `review-runner.js` surface remains intact for `review-runner.test.js`; the old exports are still re-exported from the facade.

No review semantics were intentionally changed. `parseReviewVerdict`, `validateReviewVerdict`, `applyVerdictToManifest`, `loadRubricFromRunDir`, and `buildReviewRunnerRubricGateFailure` moved behind narrower owners so the auth-boundary logic now lives in dedicated files instead of one 1708-line script.

## Facade Guard

- [`review-runner.js`](../skills/relay-review/scripts/review-runner.js) is now `385` lines.
- `grep -c '^function\|^async function' skills/relay-review/scripts/review-runner.js` returns `4`.
- `run()` remains in the facade; stage logic now lives in `context.js`, `prompt.js`, `verdict.js`, `comment.js`, `divergence.js`, `redispatch.js`, `manifest-apply.js`, and `reviewer-invoke.js`.

## Function-Level Boundary Audit

Pre-split references below point at commit `47ef371`, the last revision where every review-runner concern still lived inside `skills/relay-review/scripts/review-runner.js`.

| Pre-split line | Symbol | Final owner |
|---|---|---|
| `47ef371:review-runner.js:89` | `getArg()` | [review-runner.js](../skills/relay-review/scripts/review-runner.js#L64) |
| `47ef371:review-runner.js:96` | `hasFlag()` | [review-runner.js](../skills/relay-review/scripts/review-runner.js#L71) |
| `47ef371:review-runner.js:100` | `gh()` | [common.js](../skills/relay-review/scripts/review-runner/common.js#L5) |
| `47ef371:review-runner.js:115` | `isValidHostname()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L20) |
| `47ef371:review-runner.js:119` | `parseRemoteHost()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L24) |
| `47ef371:review-runner.js:166` | `resolveRemoteHost()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L71) |
| `47ef371:review-runner.js:205` | `hostHasGhAuth()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L110) |
| `47ef371:review-runner.js:216` | `getGhLogin()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L121) |
| `47ef371:review-runner.js:273` | `git()` | [common.js](../skills/relay-review/scripts/review-runner/common.js#L13) |
| `47ef371:review-runner.js:281` | `parsePositiveInt()` | [common.js](../skills/relay-review/scripts/review-runner/common.js#L21) |
| `47ef371:review-runner.js:290` | `readText()` | [common.js](../skills/relay-review/scripts/review-runner/common.js#L30) |
| `47ef371:review-runner.js:294` | `writeText()` | [common.js](../skills/relay-review/scripts/review-runner/common.js#L34) |
| `47ef371:review-runner.js:299` | `looksLikeGitRepo()` | [common.js](../skills/relay-review/scripts/review-runner/common.js#L39) |
| `47ef371:review-runner.js:303` | `getExpectedManifestRepoRoot()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L198) |
| `47ef371:review-runner.js:307` | `resolvePrForBranch()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L202) |
| `47ef371:review-runner.js:314` | `resolveBranchForPr()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L209) |
| `47ef371:review-runner.js:319` | `resolveIssueNumber()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L178) |
| `47ef371:review-runner.js:339` | `loadDoneCriteria()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L306) |
| `47ef371:review-runner.js:395` | `loadDiff()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L362) |
| `47ef371:review-runner.js:403` | `formatPriorRoundContext()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L370) |
| `47ef371:review-runner.js:420` | `formatRubricWarning()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L391) |
| `47ef371:review-runner.js:435` | `createRubricLoad()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L406) |
| `47ef371:review-runner.js:450` | `loadRubricFromRunDir()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L421) |
| `47ef371:review-runner.js:526` | `buildPrompt()` | [prompt.js](../skills/relay-review/scripts/review-runner/prompt.js#L8) |
| `47ef371:review-runner.js:588` | `parseReviewVerdict()` | [verdict.js](../skills/relay-review/scripts/review-runner/verdict.js#L11) |
| `47ef371:review-runner.js:598` | `validateIssue()` | [verdict.js](../skills/relay-review/scripts/review-runner/verdict.js#L21) |
| `47ef371:review-runner.js:613` | `validateRubricScore()` | [verdict.js](../skills/relay-review/scripts/review-runner/verdict.js#L36) |
| `47ef371:review-runner.js:638` | `validateScopeDrift()` | [verdict.js](../skills/relay-review/scripts/review-runner/verdict.js#L57) |
| `47ef371:review-runner.js:660` | `validateReviewVerdict()` | [verdict.js](../skills/relay-review/scripts/review-runner/verdict.js#L79) |
| `47ef371:review-runner.js:727` | `formatIssueList()` | [comment.js](../skills/relay-review/scripts/review-runner/comment.js#L6) |
| `47ef371:review-runner.js:731` | `appendCommentWarnings()` | [comment.js](../skills/relay-review/scripts/review-runner/comment.js#L10) |
| `47ef371:review-runner.js:741` | `buildCommentBody()` | [comment.js](../skills/relay-review/scripts/review-runner/comment.js#L37) |
| `47ef371:review-runner.js:792` | `splitMarkdownTableRow()` | [divergence.js](../skills/relay-review/scripts/review-runner/divergence.js#L4) |
| `47ef371:review-runner.js:799` | `isMarkdownTableDivider()` | [divergence.js](../skills/relay-review/scripts/review-runner/divergence.js#L11) |
| `47ef371:review-runner.js:804` | `isMissingScoreCell()` | [divergence.js](../skills/relay-review/scripts/review-runner/divergence.js#L16) |
| `47ef371:review-runner.js:809` | `parseScoreLog()` | [divergence.js](../skills/relay-review/scripts/review-runner/divergence.js#L21) |
| `47ef371:review-runner.js:861` | `normalizeFactorKey()` | [divergence.js](../skills/relay-review/scripts/review-runner/divergence.js#L73) |
| `47ef371:review-runner.js:865` | `parseNumericScore()` | [divergence.js](../skills/relay-review/scripts/review-runner/divergence.js#L77) |
| `47ef371:review-runner.js:873` | `loadPrBody()` | [divergence.js](../skills/relay-review/scripts/review-runner/divergence.js#L85) |
| `47ef371:review-runner.js:883` | `formatDelta()` | [divergence.js](../skills/relay-review/scripts/review-runner/divergence.js#L95) |
| `47ef371:review-runner.js:887` | `buildScoreDivergenceAnalysis()` | [divergence.js](../skills/relay-review/scripts/review-runner/divergence.js#L99) |
| `47ef371:review-runner.js:930` | `formatPriorVerdictSummary()` | [prompt.js](../skills/relay-review/scripts/review-runner/prompt.js#L70) |
| `47ef371:review-runner.js:943` | `formatScopeDrift()` | [comment.js](../skills/relay-review/scripts/review-runner/comment.js#L20) |
| `47ef371:review-runner.js:960` | `detectChurnGrowth()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L48) |
| `47ef371:review-runner.js:977` | `buildRedispatchPrompt()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L8) |
| `47ef371:review-runner.js:1017` | `normalizeFingerprintPart()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L73) |
| `47ef371:review-runner.js:1024` | `fingerprintIssue()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L80) |
| `47ef371:review-runner.js:1033` | `readPriorVerdicts()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L89) |
| `47ef371:review-runner.js:1043` | `computeRepeatedIssueCount()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L99) |
| `47ef371:review-runner.js:1060` | `toEscalatedVerdict()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L116) |
| `47ef371:review-runner.js:1069` | `buildRubricRecoveryCommand()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L125) |
| `47ef371:review-runner.js:1073` | `buildRubricGateRedispatchPrompt()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L129) |
| `47ef371:review-runner.js:1104` | `buildReviewRunnerRubricGateFailure()` | [redispatch.js](../skills/relay-review/scripts/review-runner/redispatch.js#L160) |
| `47ef371:review-runner.js:1142` | `refreshManifestWithoutStateChange()` | [manifest-apply.js](../skills/relay-review/scripts/review-runner/manifest-apply.js#L3) |
| `47ef371:review-runner.js:1153` | `applyVerdictToManifest()` | [manifest-apply.js](../skills/relay-review/scripts/review-runner/manifest-apply.js#L14) |
| `47ef371:review-runner.js:1208` | `resolveContext()` | [context.js](../skills/relay-review/scripts/review-runner/context.js#L214) |
| `47ef371:review-runner.js:1257` | `postComment()` | [comment.js](../skills/relay-review/scripts/review-runner/comment.js#L88) |
| `47ef371:review-runner.js:1264` | `captureGitStatus()` | [reviewer-invoke.js](../skills/relay-review/scripts/review-runner/reviewer-invoke.js#L63) |
| `47ef371:review-runner.js:1268` | `applyPolicyViolationToManifest()` | [manifest-apply.js](../skills/relay-review/scripts/review-runner/manifest-apply.js#L69) |
| `47ef371:review-runner.js:1287` | `resolveReviewerName()` | [reviewer-invoke.js](../skills/relay-review/scripts/review-runner/reviewer-invoke.js#L10) |
| `47ef371:review-runner.js:1294` | `resolveReviewerScript()` | [reviewer-invoke.js](../skills/relay-review/scripts/review-runner/reviewer-invoke.js#L17) |
| `47ef371:review-runner.js:1309` | `invokeReviewer()` | [reviewer-invoke.js](../skills/relay-review/scripts/review-runner/reviewer-invoke.js#L32) |
| `47ef371:review-runner.js:1340` | `run()` | [review-runner.js](../skills/relay-review/scripts/review-runner.js#L99) |

## Runtime Import Audit

- [`review-runner.js`](../skills/relay-review/scripts/review-runner.js#L1) imports only stage modules and relay-dispatch manifest/event slices.
- [`gate-check.js`](../skills/relay-merge/scripts/gate-check.js#L1) still has no runtime `require()` against the broad `review-runner.js` surface. The only remaining `review-runner.js` string is a comment about `reviewer_login_required`.
- Direct-import tests now target the stage modules directly:
  - `review-runner-context.test.js`
  - `review-runner-verdict.test.js`
  - `review-runner-manifest-apply.test.js`
  - `review-runner-redispatch.test.js`
  - `review-runner-prompt.test.js`
  - `review-runner-comment.test.js`
  - `review-runner-divergence.test.js`
  - `review-runner-reviewer-invoke.test.js`

## Grep Evidence

```text
$ wc -l skills/relay-review/scripts/review-runner.js
385 skills/relay-review/scripts/review-runner.js
```

```text
$ grep -c '^function\|^async function' skills/relay-review/scripts/review-runner.js
4
```

```text
$ grep -n 'require.*review-runner' skills/relay-merge/scripts/gate-check.js
<no output>
```

## Tests

- Direct-import review-stage suite: `node --test skills/relay-review/scripts/*.test.js`
- Result: `121/121` passing.
- Full suite: `node --test skills/relay-intake/scripts/*.test.js skills/relay-plan/scripts/*.test.js skills/relay-dispatch/scripts/*.test.js skills/relay-review/scripts/*.test.js skills/relay-merge/scripts/*.test.js`
- Result: `509/509` passing.

## Deferred Inventory

- `#190` grandfather retirement remains separate.
- `#191` resolver / CLI hygiene remains separate.
- No barrel `review-runner/index.js` was added.
- `invoke-reviewer-codex.js` and `invoke-reviewer-claude.js` stay untouched.

## Line-Number Drift Discipline

This doc was written after the post-split files stabilized. If the source changes again before merge, regenerate the audit-table links and grep evidence as the last edit of the round.
