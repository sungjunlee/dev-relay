# Rubric Design Guide

How to derive high-quality rubrics from task acceptance criteria. Covers the guided interview, design principles, and fix patterns for validation failures.

## Guided Interview

Walk through these questions to derive rubric factors from AC. Each question maps to a rubric element.

### Q1: What domain is this?

Match the task to a domain rubric reference:

| Signal | Domain | Reference |
|--------|--------|-----------|
| UI, pages, interactions, components | Frontend | `rubric-frontend.md` |
| API, data layer, services, infrastructure | Backend | `rubric-backend.md` |
| User flows, visual design, UX decisions | Design | `rubric-design.md` |
| README, guides, API docs, specs | Documentation | `rubric-documentation.md` |
| Restructuring, migration, cleanup, tech debt | Refactoring | `rubric-refactoring.md` |

If the task spans domains, pick the primary one and add 1-2 factors from the secondary.

### Q2: What can you measure with a command?

For each AC item, ask: "Can I write a shell command that checks this?"

- **Yes → automated factor.** Write the command. Define the target (exit code, threshold, comparison to baseline).
- **No → evaluated factor.** Move to Q3.

Examples of the split:

| AC item | Measurable? | Factor type |
|---------|-------------|-------------|
| "API responds within 200ms" | `curl -w '%{time_total}'` | automated |
| "Graceful error handling" | Requires reading code | evaluated |
| "No N+1 queries" | `grep -c SELECT` in test logs | automated |
| "Clean component boundaries" | Requires judgment | evaluated |
| "All links in docs work" | `npx markdown-link-check` | automated |

**Bias toward automated.** Every factor you can automate is one less thing the agent can self-score generously.

### Q3: What does a specialist check that a junior misses?

For evaluated factors, load the domain reference and pick criteria that match the AC intent. Don't invent — the domain references contain expert-level criteria already.

For each evaluated factor, write:
- **criteria**: 3-5 specific bullets, each a concrete thing to check. Written as a domain expert would explain to a capable junior.
- **target**: score threshold (typically ≥ 7/10 for best-effort, ≥ 8/10 for required)
- **weight**: required (must meet target) or best-effort (note in PR if below)

### Q4: What does failure look like?

For each evaluated factor, write the `score_low_if` line. This is one sentence describing what a low score looks like.

**This is the most important question.** Without `score_low_if`, the agent lacks an anchor for the bottom of the scale and drifts toward generous self-scoring.

Process:
1. Imagine the worst plausible implementation that "technically works"
2. What's wrong with it? That's your `score_low_if`
3. Test: would a junior reading `score_low_if` know the difference between 3/10 and 8/10?

Examples:

| Factor | Bad `score_low_if` | Good `score_low_if` |
|--------|-------------------|---------------------|
| Error handling | "errors not handled well" | "no timeouts on external calls, retry-on-everything, errors swallowed silently" |
| Component design | "bad component structure" | "prop drilling > 3 levels, components that only exist in one context but are 'reusable'" |
| Documentation | "incomplete docs" | "steps assume tools not mentioned, no version requirements, reader can't tell if they succeeded" |

### Q5: What's the baseline?

For delta metrics (performance, bundle size, complexity, dead code), the target should be relative to the current state, not an arbitrary number.

- Define a `baseline` command that captures the before-state
- Frame automated targets as "≤ baseline" or "≤ baseline + 10%"
- Run automated checks BEFORE any changes to establish the baseline

Skip this for absolute targets (exit 0, 0 violations) or new features with no before-state.

## Design Principles

Six principles for rubric quality, derived from autoresearch patterns and evaluation research.

### 1. 3-5 factors per task

More slows iteration without adding signal. Fewer misses important dimensions. If you have 7 factors, two of them are probably measuring the same thing — merge them.

### 2. Always include at least 1 automated check

A rubric with only evaluated factors has no ground truth. The agent can self-score generously on every dimension and declare success. At least one automated check provides an objective anchor.

### 3. Measure outcomes, not proxies

"Tests pass" is a proxy. "API responds in < 200ms under load" is an outcome. "No lint errors" is a proxy. "Cyclomatic complexity ≤ baseline" is closer to the real concern.

The difference: a proxy can be gamed without improving the thing you actually care about.

### 4. Think like a specialist

What would a senior frontend/backend/design/docs person check that a junior would miss? That's your evaluated factor. The domain rubric references (`rubric-*.md`) encode this expertise — use them instead of inventing generic criteria.

### 5. Baseline before changes

For delta metrics (bundle size, query count, complexity), capture the before-state. Improvement is keep, regression is discard. This is the autoresearch pattern: a fixed evaluation harness that the agent cannot modify.

### 6. Read-only evaluation

The metric measurement command should not be something the agent can game. Separate the evaluation from the implementation — just like autoresearch's read-only `prepare.py`. If the agent can modify both the code and the test that checks it, the signal is compromised.

## Fix Patterns

When validation fails (SKILL.md § Validate the rubric), use these patterns to fix.

### "No automated check"

**Symptom**: All factors are evaluated (scored by agent reading code).

**Fix**: Find the most objective AC item and convert it to a command:
- Behavior: test suite → `npm test` (exit 0)
- Performance: response time → `curl -w '%{time_total}'`
- Size: bundle/binary → `du -b` or `npx bundlesize`
- Correctness: type check → `tsc --noEmit`
- Quality: lint → `npx eslint --max-warnings 0`

If nothing is directly measurable, add a test suite pass as the minimum automated check.

### "Missing score_low_if"

**Symptom**: Evaluated factor has `criteria` but no `score_low_if`.

**Fix**: Ask Q4 from the interview: "Imagine the worst plausible implementation that technically works. What's wrong with it?" Write that as one sentence.

### "Vague criteria"

**Symptom**: Criteria use words like "good," "proper," "clean," "appropriate."

**Fix**: Replace each vague word with the specific thing you'd check:
- "good error handling" → "timeouts on external calls, retry with backoff on idempotent ops only, circuit breaking after N failures"
- "clean code" → "functions < 20 lines, no nested callbacks > 2 levels, names describe behavior not implementation"
- "proper testing" → "unit tests for business logic, integration test for the API endpoint, edge cases for empty/null/boundary inputs"

### "Too many factors"

**Symptom**: 6+ factors, iteration is slow, some factors overlap.

**Fix**:
1. Merge factors that check the same underlying quality (e.g., "readable code" and "good naming" → one "concept clarity" factor)
2. Demote the least important to best-effort or remove entirely
3. If still > 5, the task scope is too large — split the task

### "Relative targets"

**Symptom**: Targets use "good," "fast," "clean" instead of numbers.

**Fix**:
- Timed metrics: specific threshold ("< 200ms", "< 3s")
- Score metrics: specific threshold ("≥ 7/10", "≥ 8/10")
- Count metrics: specific limit ("≤ 3", "= 0") or baseline-relative ("≤ baseline")
- Binary metrics: pass/fail ("exit 0", "0 violations")

### "Proxy metrics"

**Symptom**: Automated check measures effort, not outcome. "Tests exist" instead of "tests pass." "Docs written" instead of "reader can complete task."

**Fix**: Push one step further toward the user/outcome:
- "Tests exist" → "Tests pass" → "Tests cover the changed code paths"
- "Docs written" → "Code examples run" → "Reader testing score ≥ 8/10"
- "No lint errors" → "Complexity ≤ baseline" → "Functions < 20 lines"
