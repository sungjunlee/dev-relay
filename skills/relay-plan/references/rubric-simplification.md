# Rubric Simplification

Apply this pass to every draft rubric before persistence. The goal is to keep the contract observable without turning implementation choices into requirements.

## Heuristics

1. **Strip implementation prescription disguised as contract.** Phrases like "structured failure sentinel", "use lookup table not ternary", "split into helper function" prescribe HOW. Replace with WHAT: "operator can distinguish failure from success", "pattern is greppable", etc.
2. **Replace exhaustive enumeration with core-axis principles.** "Tests cover cases (1)..(8)" → "tests cover the three observable axes: success, failure-non-fatal, multi-round". Let executor design the actual test set.
3. **Remove defensive clauses without evidence.** "MUST handle gh stderr > 500 chars" with no past incident — strip. Keep defense only when memory or sprint history names a real failure.
4. **Flag duplicate/overlapping factors.** Two factors that score the same observable behavior — merge or distinguish.
5. **Verify weights sum to 100** and **flag any factor weighted < 10%** (probably should be merged or dropped).
6. **Strip "must be exactly N lines"** style constraints — that's editorial, not contract.

## 1. Strip Implementation Prescription Disguised as Contract

**Rule** - Strip implementation prescription disguised as contract.

**Why it matters** - Executors read prescriptive rubric language as binding spec. A HOW phrase can turn a simple observable outcome into extra helpers, data shapes, and branches.

**Example** - W17 #277 / PR #282, `skills/relay-review/scripts/review-runner/pr-body-snapshot.js` (76 lines, ~30 over-engineered):

- Before (prescriptive): "Failure produces a structured sentinel with non-empty reason and no raw stack; use a dedicated builder if needed."
- After (WHAT): "On failure, the snapshot file contains a one-line human-readable reason. Reviewer can distinguish failure from success by reading the text."

The original rubric phrase, "structured failure sentinel -- NOT empty string AND NOT raw stack trace", encouraged `buildFailureSentinel`, `summarizeGhFailure`, and `collapseWhitespace` even though `writePrBodySnapshot` only needed prose failure text.

## 2. Replace Exhaustive Enumeration With Core-Axis Principles

**Rule** - Replace exhaustive enumeration with core-axis principles.

**Why it matters** - Long case lists make the executor preserve every listed item as a design constraint. That often creates one-off builders or local wrappers instead of a smaller implementation that covers the same behavior.

**Example** - W17 #281 / PR #283, `skills/relay-dispatch/scripts/recover-commit.js` (402 lines, ~150 over-structured):

- Before (enumerative): "Tests cover: (1) happy path, (2) no changes to commit, (3) missing run-id, (4) missing reason, (5) --dry-run preview, (6) pr-body-file loading, (7) pr_number stamping, (8) event emission."
- After (axis-based): "Tests cover the three observable axes: success (commits + push + PR open + event emitted), precondition failure (no changes / missing run-id / missing reason rejected with clear message), and recovery-flow state (dry-run preview, event journal append, pr_number stamping)."

The enumeration encouraged local `git()` / `gh()` re-implementations plus `buildPrBody`, `defaultPrTitle`, and `buildCommitBody`, each used only once, despite shared helpers already existing near `dispatch.js`.

## 3. Remove Defensive Clauses Without Evidence

**Rule** - Remove defensive clauses without evidence.

**Why it matters** - Defensive language sounds like reliability work, but without a named incident it expands the contract arbitrarily. Executors may spend code on imagined failures instead of the acceptance criteria.

**Example**:

- Before: "The command MUST handle gh stderr over 500 chars, binary output, and malformed UTF-8 without losing state."
- After: "When `gh` fails, the command reports a clear error and leaves manifest state unchanged."

Keep the longer defensive clause only when memory, sprint history, or a linked issue names that exact failure.

## 4. Flag Duplicate/Overlapping Factors

**Rule** - Flag duplicate/overlapping factors.

**Why it matters** - Duplicate factors double-count the same observable behavior. Executors may add redundant mechanisms to satisfy each factor separately, and reviewers lose a clear scoring signal.

**Example**:

- Before: Factor A: "Run resolution rejects unknown run IDs." Factor B: "Invalid run identifiers produce clear failure output."
- After: One factor: "Run resolution rejects unknown or invalid run identifiers with a clear message before side effects."

Merge factors that score the same user-visible result, or distinguish the unique observable behavior each factor owns.

## 5. Verify Weights Sum to 100 and Flag Any Factor Weighted < 10%

**Rule** - Verify weights sum to 100 and flag any factor weighted < 10%.

**Why it matters** - Weight drift hides priority mistakes. Tiny factors are often editorial preferences or duplicate checks that should be merged into a larger contract or removed.

**Example**:

- Before: "Behavior 45%, tests 35%, docs 15%, option naming 5%."
- After: "Behavior 45%, tests 35%, operator documentation 20%; option naming is a criterion under behavior if it affects CLI compatibility."

If the task uses `required` / `best-effort` instead of numeric weights, apply the same lens to factor count and scoring emphasis.

## 6. Strip "Must Be Exactly N Lines" Style Constraints

**Rule** - Strip "must be exactly N lines" style constraints.

**Why it matters** - Line counts are editorial, not contract. They can cause awkward code golf or filler and distract from whether the behavior is correct and maintainable.

**Example**:

- Before: "The new helper must be exactly 20 lines and the PR description must be three bullets."
- After: "The helper stays small enough to read inline, and the PR description names the behavior change, validation, and residual risk."

Prefer observable readability and completeness over fixed counts unless a format truly requires a limit.
