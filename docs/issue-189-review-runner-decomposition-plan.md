# Issue #189 — Decompose `review-runner.js` into staged pipeline helpers

Third item of Epic #192 (Runtime Boundary Cleanup). Unblocked by #187 + #188 landing (both merged 2026-04-18). This refactor is the last Epic A item before `#198` (orchestrator push+PR creation) can unblock.

## Problem statement

`skills/relay-review/scripts/review-runner.js` is 1708 lines, 63 top-level functions, 18 exports. It is a god file: a single top-level `run()` owns every review concern — rubric/context loading, prompt assembly, reviewer invocation, verdict parsing/validation, GitHub comment rendering, score-divergence analysis, redispatch prompt generation, repeat-issue fingerprinting, and manifest mutation.

Two consumers exist outside the file:

- `skills/relay-review/scripts/review-runner.test.js` (primary test consumer; imports most exports)
- `skills/relay-merge/scripts/gate-check.js` (cross-skill consumer; uses `loadRubricFromRunDir` + `buildReviewRunnerRubricGateFailure`)

## Goal

After this PR:

- The top-level runner reads as orchestration — a `run()` function that reads CLI args, calls stage helpers in order, and writes manifest transitions. No embedded multi-concern logic blocks.
- Stage helpers live in narrower modules under `skills/relay-review/scripts/review-runner/`. Each module owns one concern (context, prompt, verdict, comment, divergence, redispatch, manifest-apply, reviewer-invoke).
- `review-runner.js` retains the `run()` orchestrator + re-exports so the two existing consumers (test file + `gate-check.js`) do not all need to change.
- Gate-layer contracts (verdict validation, rubric load fail-closed, manifest-apply transition gate) retain byte-identical behavior. The verdict schema, the fail-closed matrix, and the `applyVerdictToManifest` state transitions are NOT rewritten — just moved.

Unlike `relay-manifest.js` (which became a pure re-export facade in #188), `review-runner.js` cannot become a pure facade because it has a live `run()` orchestrator bound to the CLI entry point. It becomes a **thin orchestrator** instead: CLI parsing + `run()` + re-exports.

## Proposed shape

Eight new modules under `skills/relay-review/scripts/review-runner/`:

| New module | Owns (source of truth) | Pre-split function inventory |
|------------|------------------------|------------------------------|
| `review-runner/context.js` | Done Criteria + diff load, issue resolution, GH login resolution, rubric load | `loadDoneCriteria`, `loadDiff`, `formatPriorRoundContext`, `loadRubricFromRunDir`, `resolveIssueNumber`, `resolveRemoteHost`, `getGhLogin`, `parseRemoteHost`, `isValidHostname`, `hostHasGhAuth`, `formatRubricWarning`, `createRubricLoad` |
| `review-runner/prompt.js` | Reviewer prompt assembly from context | `buildPrompt`, `formatPriorVerdictSummary` |
| `review-runner/verdict.js` | Reviewer-response parsing + schema validation | `parseReviewVerdict`, `validateReviewVerdict`, `validateIssue`, `validateRubricScore`, `validateScopeDrift` |
| `review-runner/comment.js` | GitHub comment rendering + posting | `buildCommentBody`, `formatIssueList`, `appendCommentWarnings`, `formatScopeDrift`, `postComment` |
| `review-runner/divergence.js` | Score-log parsing + executor/reviewer score-divergence analysis | `splitMarkdownTableRow`, `isMarkdownTableDivider`, `isMissingScoreCell`, `parseScoreLog`, `normalizeFactorKey`, `parseNumericScore`, `loadPrBody`, `formatDelta`, `buildScoreDivergenceAnalysis` |
| `review-runner/redispatch.js` | Redispatch prompt + repeat-issue detection + escalation policy | `buildRedispatchPrompt`, `detectChurnGrowth`, `normalizeFingerprintPart`, `fingerprintIssue`, `readPriorVerdicts`, `computeRepeatedIssueCount`, `toEscalatedVerdict`, `buildRubricRecoveryCommand`, `buildRubricGateRedispatchPrompt`, `buildReviewRunnerRubricGateFailure` |
| `review-runner/manifest-apply.js` | Manifest state transitions for review outcomes | `refreshManifestWithoutStateChange`, `applyVerdictToManifest`, `applyPolicyViolationToManifest` |
| `review-runner/reviewer-invoke.js` | External reviewer adapter invocation + policy-violation detection | `resolveReviewerName`, `resolveReviewerScript`, `invokeReviewer`, `captureGitStatus` |

`review-runner.js` keeps:

- CLI argv parsing (`getArg`, `hasFlag`)
- The `run()` orchestrator (currently ~350 lines — most of the shrinkage comes from delegating stage work)
- Tiny shared helpers with no natural home: `gh`, `git`, `readText`, `writeText`, `parsePositiveInt`, `looksLikeGitRepo`, `getExpectedManifestRepoRoot`, `resolvePrForBranch`, `resolveBranchForPr`, `resolveContext`
- Re-exports for the two external consumers:
  - `buildReviewRunnerRubricGateFailure` (used by `gate-check.js`)
  - `loadRubricFromRunDir` (used by `gate-check.js`)
  - All 18 pre-split exports kept via re-export for the test consumer

Target post-split size: `review-runner.js` ≤ ~400 lines (down from 1708).

## Migration scope (in this PR)

**Must migrate to narrower imports** (runtime cross-skill consumer):

- `skills/relay-merge/scripts/gate-check.js` — migrate `loadRubricFromRunDir` and `buildReviewRunnerRubricGateFailure` imports to `review-runner/context.js` and `review-runner/redispatch.js` respectively.

**Must NOT migrate in this PR**:

- `skills/relay-review/scripts/review-runner.test.js` — stays on the main `review-runner.js` surface via the re-export layer. This is the whole reason re-exports exist. Test migration is a follow-up.

The fence is bounded: only one runtime consumer to migrate. If the split produces stage modules that are genuinely self-sufficient, `gate-check.js` will migrate cleanly. If it doesn't, the split is wrong.

## Rubric (draft, Grade B — trust-model required)

Size L, 8 factors (6 contract + 2 quality). Same shape as #188 — the refactor pattern is twin-to-twin. Incorporates the two lessons from #188:

- **Matrix depth**: factors enumerate the behavior matrix explicitly (all verdict variants, all transition states), not just "covers N cases". Per `memory/feedback_refactor_byte_identical_matrix.md`.
- **PR-creation mechanics**: the prompt explicitly instructs the executor to commit + push + open the PR. If the executor does not, the orchestrator recovers mechanically per `memory/feedback_executor_did_not_open_pr.md`.

### Prerequisites

- `node --test skills/**/scripts/*.test.js` exits 0 on PR HEAD (baseline 465/465 post-#188 merge).
- `grep -rn 'require.*review-runner' skills/` — only `review-runner.test.js` + `gate-check.js` reach for the main file post-PR.

### Contract factors

**1. Stage modules exist; `review-runner.js` becomes a thin orchestrator**

- New directory `skills/relay-review/scripts/review-runner/` with eight files matching the "Proposed shape" table.
- Each file exports exactly the functions listed in that table; no bonus exports, no hidden helpers leaked between stages.
- `review-runner.js` retains only: CLI parsing, `run()`, tiny shared helpers (named above), and re-exports for the 18 pre-split exports.
- Automated: `wc -l skills/relay-review/scripts/review-runner.js` returns ≤ 420.
- Automated: `grep -c '^function\|^async function' skills/relay-review/scripts/review-runner.js` returns ≤ 12 (CLI helpers + `run()`).

**2. Verdict gate behavior byte-identical post-split (trust-model Q1 — forge)**

Threat model: attacker-controlled reviewer output. The verdict gate reads `review-round-N-raw-response.txt` and must reject malformed / forged verdicts without reaching `applyVerdictToManifest`. After the split, `parseReviewVerdict` and `validateReviewVerdict` in `review-runner/verdict.js` must accept and reject the same inputs as the pre-split functions.

Matrix enumeration (factor criterion, not criterion bullet):

- All four verdict values — `pass`, `changes_requested`, `escalated`, `skip` — each with valid body → accepted.
- Each verdict value with missing-required-field body → rejected with pre-split error message.
- Verdict with `issues` array containing a malformed entry (missing title / wrong severity / non-string body) → rejected.
- Verdict with `rubric_scores` containing a non-numeric score or unknown status → rejected.
- Verdict with `scope_drift` missing the `missing` / `creep` arrays → rejected.
- Verdict with stray top-level keys → preserved / stripped per pre-split behavior (document which).

Each matrix row is a direct-import regression test in `review-runner/verdict.test.js` that imports `parseReviewVerdict` / `validateReviewVerdict` without going through `review-runner.js`.

**3. Manifest-apply gate behavior byte-identical post-split (trust-model Q2 — gate)**

`applyVerdictToManifest` is the second gate. It takes a verdict, the current manifest state, the current round number, and the PR + reviewed-head-sha, and advances the manifest through `updateManifestState` with `validateTransition` enforcement. Post-split, it lives in `review-runner/manifest-apply.js` and must:

- Call `updateManifestState` from the `manifest/lifecycle.js` slice that #188 created (not from the retired facade).
- Accept the same set of `(state, verdict)` pairs as pre-split:
  - `review_pending + pass` → `ready_to_merge`.
  - `review_pending + changes_requested` → `changes_requested`.
  - `review_pending + escalated` → `escalated`.
  - `changes_requested + pass` → `ready_to_merge`.
  - `changes_requested + changes_requested` → remains `changes_requested` (re-dispatch increments round).
  - Pre-existing terminal-state / transition-denial behavior preserved exactly.
- Write the same manifest fields: `review.last_reviewed_sha`, `review.latest_verdict`, `review.rounds`, `next_action`, `review.repeated_issue_count`.

Factor requires a parameterized test in `review-runner/manifest-apply.test.js` that enumerates all pre-split valid `(state, verdict)` pairs with expected target state + expected field writes. Direct import only (no `review-runner.js` facade).

**4. Rubric gate preserved (trust-model Q3 — external verifier)**

`loadRubricFromRunDir` + `buildReviewRunnerRubricGateFailure` together form the rubric-load fail-closed path. Pre-split:

- `loadRubricFromRunDir` returns `{ state, status, content, warning, rubricPath, resolvedPath, error }`.
- When `state ∈ {not-loaded, corrupt, missing}`, `run()` calls `buildReviewRunnerRubricGateFailure` which returns a structured failure directing the operator to `relay-migrate-rubric.js`.

Post-split these live in `review-runner/context.js` and `review-runner/redispatch.js` respectively. Factor requires:

- `gate-check.js` migration imports `loadRubricFromRunDir` from `review-runner/context.js` (not from `review-runner.js`).
- `gate-check.js` migration imports `buildReviewRunnerRubricGateFailure` from `review-runner/redispatch.js`.
- Direct-import test in `review-runner/context.test.js` covers: registered rubric path → loaded; unregistered path → gate failure; missing file → gate failure with specific reason string matching pre-split. Same five cases as the #188 rubric gate (including `..` traversal and symlink escape) — the rubric-load path must fail closed identically.
- `relay-manifest.test.js` facade coverage (via the #188 facade) remains green — proves consumers through both import paths see the same result.

**5. Single runtime consumer migration — `gate-check.js` imports from narrower modules**

- `skills/relay-merge/scripts/gate-check.js` replaces `require("../../relay-review/scripts/review-runner")` (or equivalent path) with `require("../../relay-review/scripts/review-runner/context")` and `.../redispatch`.
- Grep-proof in PR body: `grep -n 'require.*review-runner' skills/relay-merge/scripts/gate-check.js` returns only the narrower imports.
- `gate-check.test.js` passes unchanged — no test-file edits required as part of this migration.

**6. Test coverage parity and delta**

- Test delta target: **≥ +20 tests** across the new `review-runner/*.test.js` files. Baseline post-#188 is 465/465 green. Target final count ≥ 485.
- `review-runner.test.js` is NOT deleted. It remains as a re-export regression test proving the orchestrator re-exports produce the same outputs as the stage modules.
- Each new stage module has a `review-runner/<stage>.test.js` sibling that uses direct imports only.
- Full suite: `node --test skills/**/scripts/*.test.js` remains 100% green.
- CI run (GH Actions) shows green on the final commit; PR body links the run.

### Quality factors

**7. Import graph regression check and re-export audit**

- Grep evidence in PR body: `grep -rn 'require.*review-runner' skills/` post-PR returns exactly:
  - `skills/relay-review/scripts/review-runner.test.js` (re-export regression consumer; allowed)
  - any stage modules importing from sibling stage modules (allowed, documented in PR body)
  - zero other runtime consumers
- `gate-check.js` shows zero imports from the main `review-runner.js` (only from narrower stage files).
- A new test asserts `review-runner.js` has ≤ 420 lines AND `grep -c '^function\|^async function'` ≤ 12. The test proves the orchestrator does not regrow into a god file.

**8. Out-of-scope discipline + docs mirror + PR-creation mechanics**

- `docs/issue-189-review-runner-decomposition.md` (docs mirror, updated post-merge) contains:
  1. One-paragraph summary.
  2. Function-level audit table (per-stage): columns = function, pre-split `review-runner.js:line`, post-split `review-runner/<stage>.js:line`.
  3. Verbatim grep evidence pinned to final tree.
  4. Deferred-issue inventory: `#190` (grandfather retirement), `#191` (resolver / CLI hygiene), and the `review-runner.test.js` migration follow-up.
  5. Trust-model audit block per `references/rubric-trust-model.md#checklist--put-this-in-the-pr-body`:
     - **Q1 (forge)**: factor `verdict-gate-behavior-byte-identical`.
     - **Q2 (gate)**: factor `manifest-apply-gate-behavior-byte-identical`.
     - **Q3 (external verifier)**: factor `rubric-gate-preserved`.
- PR body repeats the trust-model block and deferred-issue inventory.
- Line-number drift discipline: audit table line numbers regenerated against final tree as last edit.
- **PR-creation mechanics**: executor MUST commit, push, and open the PR. The dispatch prompt states this explicitly. (If the executor does not — the observed #188 round-1 failure class — the orchestrator recovers mechanically per `memory/feedback_executor_did_not_open_pr.md`.)
- No new npm deps. No `review-runner/index.js` barrel module.
- No rewrite of `run()` beyond delegation. The orchestration flow (load context → build prompt → invoke reviewer → parse → validate → apply → comment) stays bit-for-bit; each step becomes a call to a stage helper instead of inline logic.

## Trust-model audit (per `references/rubric-trust-model.md`)

This task **does cross an auth boundary**. The verdict validation + manifest-apply path IS the review gate. Rubric-load fail-closed is the external-verifier path.

- **Q1 (forge)**: an attacker-controlled reviewer output could mint a `pass` verdict that reaches `applyVerdictToManifest` if the validator accepts malformed input. Post-split the validator lives in `review-runner/verdict.js` as a single owner. Factor: `verdict-gate-behavior-byte-identical` (factor 2).
- **Q2 (gate)**: `review-runner/manifest-apply.js:applyVerdictToManifest` calls `manifest/lifecycle.js:updateManifestState`, which enforces `validateTransition` from the #188 split. The chain stays intact post-refactor. Factor: `manifest-apply-gate-behavior-byte-identical` (factor 3).
- **Q3 (external verifier)**: the on-disk `review-round-N-verdict.json` + the `gate-check.js` consumer that reads the latest PR comment. Rubric load still anchors on `~/.relay/runs/<slug>/<run-id>/rubric.yaml`, cross-checked against `~/.relay/migrations/rubric-mandatory.yaml` via the manifest/rubric.js module. Factor: `rubric-gate-preserved` (factor 4).

## Out of scope

- Any change to the review semantics or fail-closed policy. The issue is explicit: "Review semantics and fail-closed policy stay unchanged."
- Any change to the reviewer adapter contract (`invoke-reviewer-codex.js`, `invoke-reviewer-claude.js`). Migration to narrower imports is allowed only if the adapter was importing from `review-runner.js` — today it is not.
- Rewriting `parseReviewVerdict`'s grammar. It stays as-is, just in a new file.
- Rewriting `buildPrompt`'s output format. Byte-identical prompts required.
- Migrating `review-runner.test.js` to stage imports. That is the whole reason re-exports exist.
- Touching `#190` (grandfather retirement) or `#191` (resolver / CLI hygiene) code paths.
- A `review-runner/index.js` barrel module.

## Expected executor difficulties

1. **Shared helpers with no clean home.** `gh`, `git`, `readText`, `writeText` are used by multiple stage modules. Options: (a) keep them in `review-runner.js` and have stage modules `require("..")` it — this creates a cycle. (b) move them to `review-runner/common.js` — adds an extra module. **Decision**: move to `review-runner/common.js`. This is a ninth module; factor 1's table lists eight; the executor should add `common.js` if needed and document it in the PR body. The ceiling is ≤ 10 stage modules.
2. **`run()` delegation.** `run()` currently has ~350 lines of inline flow. Post-split it should read as linear orchestration — roughly 20-40 calls to stage helpers. Any embedded logic block of >10 lines in `run()` post-split is a refactor miss.
3. **Circular imports between `context.js` and `redispatch.js`.** Both touch rubric gate state. Resolution: `buildReviewRunnerRubricGateFailure` in `redispatch.js` takes a `rubricLoad` parameter (already does today); no import from `context.js` required.
4. **`validateReviewVerdict` + `applyVerdictToManifest` ordering.** Pre-split, the validator runs before the manifest-apply. Post-split the two live in different files; the orchestrator must keep the call order identical.

## Next-session execution sequence

1. `node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json`.
2. `node skills/relay-dispatch/scripts/reliability-report.js --repo . --json`.
3. Finalize rubric via `/relay-plan 189` (or hand-finalize if this draft is sufficient).
4. Dispatch via `/relay-dispatch`. Dry-run first. Explicit instruction in prompt: "commit + push + open PR from the worktree before finishing" per `memory/feedback_executor_did_not_open_pr.md`.
5. Review: anticipate **2-3 rounds**. Round 1 likely-miss surface: thin verdict-matrix tests (the #188 pattern). Round 2 likely-miss surface: shared helper home (`common.js` vs cycle).

## Prior-art references

- `docs/issue-187-worktree-runtime-plan.md` + `docs/issue-188-manifest-boundary-split.md` — plan format precedent for Epic #192.
- `memory/feedback_refactor_byte_identical_matrix.md` — rubric must enumerate matrix explicitly; counts aren't enough.
- `memory/feedback_executor_did_not_open_pr.md` — recovery path if executor skips PR creation.
- `references/rubric-trust-model.md` — three-question audit template.
