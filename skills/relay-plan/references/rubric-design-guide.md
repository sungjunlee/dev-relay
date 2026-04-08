# Rubric Design Guide

How to derive high-quality rubrics from task acceptance criteria. Covers the guided interview, design principles, and fix patterns for validation failures.

## Guided Interview

Walk through these questions to design a task-specific rubric from AC. Each question derives a rubric element. The goal is a rubric tailored to *this* task, not a generic template applied to it.

### Q1: What actually matters for this task?

Read the AC and ask: "If this ships but one thing is wrong, what would hurt most?" That's your first required factor.

Then: "What's the second most important?" Keep going until you have a ranked list of concerns derived from the task, not from a menu.

Before you keep any candidate as a factor, apply the tier test. Use the same tier judgment questions everywhere:

| Tier | Question | Placement | Examples |
|------|----------|-----------|----------|
| **Hygiene** | "Would this check apply to ANY PR in this repo?" | `prerequisites` | `npm test`, `tsc --noEmit`, `eslint` |
| **Contract** | "Does this verify a SPECIFIC AC item is implemented?" | `factors` | endpoint returns paginated response, config includes new field |
| **Quality** | "Does this probe HOW well it was designed/implemented?" | `factors` | error recovery strategy, abstraction boundaries, failure mode differentiation |

**Contract = "is it there?"**  
**Quality = "is it good?"**

Classification pass:
- If the answer is "yes, this would apply to ANY PR in this repo," it is hygiene. Move it to `prerequisites`.
- Otherwise, if it verifies a specific AC item exists, keep it as a `contract` factor.
- Otherwise, if it probes how well the implementation was designed, keep it as a `quality` factor.

### Q2: What can you measure with a command?

**First, inventory available tools.** Before deciding what's measurable, know what the executor has:

```bash
# Probe the executor environment (agent tools + project tools)
${CLAUDE_SKILL_DIR}/scripts/probe-executor-env.js <repo-path> --executor <codex|claude> --json

# Or project tools only (no agent invocation)
${CLAUDE_SKILL_DIR}/scripts/probe-executor-env.js <repo-path> --project-only --json
```

The probe returns agent skills/MCP tools and project tools (npm scripts, Makefile targets, test frameworks). Each available tool is a chance to convert an evaluated factor into an automated one — the single biggest lever for rubric quality.

For each AC item, ask: "Can I write a shell command that checks this — given the tools available?"

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
| "UI flows work end-to-end" | `npx playwright test` (if available) | automated |
| "No accessibility violations" | `npx axe --exit` (if axe-core available) | automated |

Now apply the tier test to the automated candidates. Automated does not automatically mean substantive:

| Candidate check | Tier result | Placement |
|-----------------|------------|-----------|
| `npm test` | Hygiene, it would apply to ANY PR in this repo | `prerequisites` |
| `npx tsc --noEmit` | Hygiene, generic repo-wide safety | `prerequisites` |
| `curl -w '%{time_total}' /api/items` | Contract, verifies a SPECIFIC AC item and outcome | `factors` |
| `npx playwright test tests/checkout.spec.ts` | Contract, if it directly verifies this task's checkout flow | `factors` |

**Bias toward automated.** Every factor you can automate is one less thing the agent can self-score generously. Check `rubric-*.md` for tool → automated check mapping tables.

### Q3: What does a specialist check that a junior misses?

For each evaluated factor from Q1, write criteria specific to *this task*. Ask: "What would a senior engineer check here that a junior would overlook?"

Write the criteria yourself first, from the AC. Then consult the domain reference (`rubric-*.md`) for expert perspective you may have missed — they show how specialists think about quality in that domain. Borrow the *thinking*, not the bullet points. If a reference factor happens to match your task exactly, use it. But most tasks need custom criteria.

For each evaluated factor, write:
- **criteria**: 3-5 specific bullets, each a concrete thing to check. Written as a domain expert would explain to a capable junior.
- **target**: score threshold (typically ≥ 7/10 for best-effort, ≥ 8/10 for required)
- **weight**: required (must meet target) or best-effort (note in PR if below)

### Q4: What does each scoring level look like?

For each evaluated factor, write a `scoring_guide` with three anchors: `low`, `mid`, `high`. Each is one sentence describing what that level looks like.

**This is the most important question.** Without a scoring guide, the agent lacks calibration and drifts toward generous self-scoring. Three anchors give sufficient calibration without the authoring burden of a full 4-level gradient.

Process:
1. **low**: Imagine the worst plausible implementation that "technically works." What's wrong with it?
2. **mid**: What does "partially addressed" look like? Some criteria met, obvious gaps remain.
3. **high**: What does the target zone look like? All criteria satisfied, edge cases handled.

Test: would a junior reading the three levels know the difference between 3/10, 6/10, and 9/10? Each level implicitly tells the executor what to fix next — at low, aim for mid; at mid, aim for high.

Examples:

| Factor | low | mid | high |
|--------|-----|-----|------|
| Error handling | "No timeouts on external calls, retry-on-everything, errors swallowed" | "Timeouts on external calls, basic retry without backoff" | "Backoff + jitter, circuit breaking, actionable error messages" |
| Component design | "Prop drilling > 3 levels, components only used in one context but are 'reusable'" | "Clean data flow, but some over-abstraction or unnecessary indirection" | "Abstractions earn their cost, data flow traceable without jumping files" |
| Documentation | "Steps assume tools not mentioned, no version requirements, reader can't tell if they succeeded" | "Steps complete but terse, missing failure paths or edge cases" | "Zero-context reader can complete the task, happy + failure paths covered" |

#### Optional: fix_hint for directed iteration

When anchors alone aren't enough, add `fix_hint` with prescriptive transitions. This breaks the "mid trap" — where the executor reaches 5-6/10 and cannot determine which concrete action would move it higher.

```yaml
scoring_guide:
  low: "No timeouts on external calls, retry-on-everything"
  mid: "Timeouts exist but no backoff/jitter or idempotency awareness"
  high: "All four criteria met, edge cases handled"
  fix_hint:
    low_to_mid: "Add timeouts to all external HTTP/DB calls (default 5s); wrap retries in idempotency check"
    mid_to_high: "Add exponential backoff with jitter; add circuit breaker after N=3 consecutive failures"
```

**When to write fix_hints:**
- Factor has a history of plateau at mid (executor gets stuck at 5-6/10)
- Transition from mid→high requires a non-obvious technique (circuit breaking, backoff with jitter)
- Skip for factors where the anchors already make the next step obvious

**How to write them:** Imperative voice ("add X", "replace Y with Z"), not descriptive ("has X", "includes Y"). Concrete enough to be actionable, not so specific that they prescribe implementation details. Existing rubrics without `fix_hint` are valid — the executor falls back to its own judgment when the field is absent.

### Q5: What's the baseline?

For delta metrics (performance, bundle size, complexity, dead code), the target should be relative to the current state, not an arbitrary number.

- Define a `baseline` command that captures the before-state
- Frame automated targets as "≤ baseline" or "≤ baseline + 10%"
- Run automated checks BEFORE any changes to establish the baseline

Skip this for absolute targets (exit 0, 0 violations) or new features with no before-state.

## Design Principles

Six principles for rubric quality, derived from autoresearch patterns and evaluation research.

### 1. Factor counts by tier, not a flat 3-5 rule

Prerequisites (hygiene): as many as needed, uncounted.
Factors (contract + quality): satisfy the per-tier minimums first, then stop when the rubric feels complete. No hard cap, warning at 8+ substantive factors.

```text
┌─────────────┬──────────┬──────────┬───────────────────┐
│   Size      │ Contract │ Quality  │ Substantive total │
│             │   min    │   min    │                   │
├─────────────┼──────────┼──────────┼───────────────────┤
│ S (1-2 AC)  │   ≥ 1    │   ≥ 1    │  2+  (rec ~3)     │
│ M (3-4 AC)  │   ≥ 2    │   ≥ 1    │  3+  (rec ~5)     │
│ L (5-6 AC)  │   ≥ 2    │   ≥ 2    │  4+  (rec ~6)     │
│ XL (7+ AC)  │   ≥ 3    │   ≥ 2    │  5+  (rec ~8)     │
└─────────────┴──────────┴──────────┴───────────────────┘
```

If you hit 8+ substantive factors, check for overlap. Usually two factors want to be merged, or a hygiene check is masquerading as a factor and should move to `prerequisites`.

### 2. Always include at least 1 automated check across prerequisites + factors

A rubric with only evaluated factors has no ground truth. The agent can self-score generously on every dimension and declare success. At least one automated check across `prerequisites` + `factors` provides an objective anchor.

### 3. Measure outcomes, not proxies

"Tests pass" is a proxy. "API responds in < 200ms under load" is an outcome. "No lint errors" is a proxy. "Cyclomatic complexity ≤ baseline" is closer to the real concern.

The difference: a proxy can be gamed without improving the thing you actually care about.

### 4. Think like a specialist

What would a senior frontend/backend/design/docs person check that a junior would miss? That's your evaluated factor. Design criteria from the task's AC first, then consult `rubric-*.md` for expert perspective you may have missed. The references show how specialists think — borrow the mindset, not the checklist.

### 5. Baseline before changes

For delta metrics (bundle size, query count, complexity), capture the before-state. Improvement is keep, regression is discard. This is the autoresearch pattern: a fixed evaluation harness that the agent cannot modify.

### 6. Read-only evaluation

The metric measurement command should not be something the agent can game. Separate the evaluation from the implementation — just like autoresearch's read-only `prepare.py`. If the agent can modify both the code and the test that checks it, the signal is compromised.

**Automated check commands are immutable.** The dispatch prompt explicitly forbids the executor from modifying them. If a check fails, the fix is in the code — not the command. This closes the Goodhart vulnerability where the executor "improves" the scoring command itself to inflate scores.

### 7. Regression prevention

When fixing one factor, the executor may silently degrade another. Factor interference is the #1 cause of wasted iterations — the agent oscillates between factors, never converging.

**Locked factors.** When a required factor meets its target, it becomes locked. Subsequent iterations must not regress it below target. If they do, the iteration is discarded (git reset) and re-attempted with an explicit constraint to maintain the locked factor.

```
| Factor         | Target  | Iter 1 | Iter 2   | Iter 3 | Status |
|----------------|---------|--------|----------|--------|--------|
| Response time  | < 0.2s  | 0.35s  | 0.15s ✓  | —      | locked |
| Error handling | ≥ 8     | 5      | 6        | 8 ✓    | locked |
| API clarity    | ≥ 7     | 4      | 5        | 7 ✓    | locked |
```

This pattern reduces factor interference in practice by preventing silent regression during multi-factor iteration. The iteration protocol enforces it: step 2 checks for regression before proceeding.

## Grounding

Evaluated criteria must name what the executor should inspect. A criterion is grounded when the rubric points to a discoverable artifact or a concrete code pattern, not a repo-wide vibe.

Rule of thumb: if the executor would need to read 5+ files to understand the criterion, it is ungrounded. Ground it with specific references or convert it to an automated check.

| Ungrounded | Grounded |
|---|---|
| "follow the project's error handling conventions" | "use `AppError` class from `src/errors.ts`, wrap async handlers in try-catch, log via `logger.error()`" |
| "consistent API style" | "match the response shape in `src/routes/users.ts`: `{ data, meta, errors }`" |
| "production-ready logging" | "use structured JSON logging via pino; include `requestId`, `userId`, `duration` fields" |
| "matches existing component patterns" | "follow the pattern in `src/components/UserCard.tsx`: props interface, named export, co-located test file" |

Grounding is about knowledge availability. Vague wording and ungrounded wording are different failures: "good error handling" is vague; "follow the project's error handling conventions" is specific-sounding but ungrounded.

## Stuck Patterns

Three pathological iteration patterns. The iteration protocol checks all three before proceeding (iteration loop step 6).

### Single-factor stall

Same factor stays below target for 3 consecutive iterations. The executor is trying the same approach repeatedly.

```
| Factor         | Target | Iter 1 | Iter 2 | Iter 3 |
|----------------|--------|--------|--------|--------|
| Error handling | ≥ 8    | 5      | 5      | 5      | ← stalled (3 iters below target, no progress)
```

### Oscillation

Any two factors alternate regression across 4+ iterations. Each individually "improves" on alternate iterations, but net progress is zero. Check all factor pairs.

```
| Factor         | Target | Iter 1 | Iter 2 | Iter 3 | Iter 4 |
|----------------|--------|--------|--------|--------|--------|
| Response time  | < 0.2s | 0.35s  | 0.15s  | 0.40s  | 0.12s  | ← oscillating with error handling
| Error handling | ≥ 8    | 5      | 3      | 7      | 4      | ← oscillating with response time
```

This is a multi-objective optimization failure — fixing one factor's code path degrades another's. Prevention: design factors with minimal overlap; check for shared code paths during rubric design.

### Plateau

No required factor has improved toward its target over 2 consecutive iterations. Individual factors may fluctuate, but none makes progress.

```
| Factor    | Target | Iter 1 | Iter 2 | Iter 3 |
|-----------|--------|--------|--------|--------|
| Factor A  | ≥ 8    | 5      | 6      | 5      | ← no net improvement from iter 1→3
| Factor B  | ≥ 7    | 4      | 3      | 4      | ← no net improvement from iter 1→3
```

The executor checks each required factor individually: did it move closer to its target compared to 2 iterations ago? If none did, the system is plateaued. This avoids summing scores across incompatible units (seconds, scores, counts).

## Complexity Budget (Recommended)

Each iteration adds defensive code, null checks, and edge case handling. After 3-5 iterations, a 20-line function can become 80 lines of primarily defensive code with core logic buried.

For tasks expecting 3+ iterations, consider adding a complexity baseline as a best-effort factor:

```yaml
- name: Complexity budget
  type: automated
  command: "<see ecosystem examples below>"
  target: "≤ baseline"
  weight: best-effort
```

Commands by ecosystem:
- **Node.js/TS**: `npx eslint --no-eslintrc --rule '{complexity: [error, 15]}' 'src/**/*.{js,ts}' 2>&1 | grep -c 'error' || echo 0`
- **Python**: `radon cc -s -a -nc src/ | tail -1`
- **General**: `wc -l` on changed files (crude but directional)

This is a recommendation, not a required validation step. Rubric designers decide whether to include it. Frame as `best-effort` — note in PR if exceeded, don't block. Simpler is better: removing something and getting equal or better results is a simplification win (autoresearch principle).

## Calibration (Optional)

Test whether your rubric produces consistent scores before dispatching. Recommended for high-stakes tasks or rubrics with novel/custom criteria.

### Protocol

1. **Score 3 times**: Evaluate each evaluated factor against the current codebase state 3 times independently. Each run should be a fresh evaluation — don't reference previous scores.
2. **Record the spread**: For each factor, note the min and max score across the 3 runs.
3. **Flag high-variance factors**: Any factor with a spread > 2 points (e.g., scores of 5, 7, 8) has inconsistent criteria.
4. **Fix or accept**:
   - Spread ≤ 2: consistent enough — proceed.
   - Spread > 2: the criteria are ambiguous. Tighten them using the fix patterns below, then re-calibrate.
   - If a factor stays high-variance after one rewrite, consider converting it to an automated check (Q2) or splitting it into narrower factors.

### Why Variance Matters

A factor that scores 4 one run and 8 the next will cause the iteration loop to make random keep/discard decisions. The agent keeps a change because it "improved" from 5→7 on one run, but would have scored 7→6 on another. High variance = noise, not signal.

### Common Causes of High Variance

| Cause | Example | Fix |
|-------|---------|-----|
| Vague criteria | "good error handling" | Specific bullets (see Fix Patterns § Vague criteria) |
| Missing `scoring_guide` | No calibration anchors for the scale | Add low/mid/high (see Q4 in Guided Interview) |
| Criteria too broad | Factor covers 4+ distinct concerns | Split into 2 narrower factors |
| Subjective threshold | "readable" means different things each run | Replace with measurable proxy ("functions < 20 lines") |

### When to Skip

- All factors are automated (no LLM scoring to calibrate)
- Low-complexity tasks where factors are straightforward and unlikely to be ambiguous
- Low-stakes tasks where a noisy signal is acceptable (bugs, typos)

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

### "Missing scoring_guide"

**Symptom**: Evaluated factor has `criteria` but no `scoring_guide` (or only a single `score_low_if` anchor).

**Fix**: Ask Q4 from the interview. Write three levels:
1. **low**: Worst plausible implementation that "technically works" — what's wrong with it?
2. **mid**: Partially addressed — some criteria met, obvious gaps remain.
3. **high**: Target zone — all criteria satisfied, edge cases handled.

One sentence per level is enough. If you can't distinguish mid from high, the criteria are too vague — tighten them first.

### "Vague criteria"

**Symptom**: Criteria use words like "good," "proper," "clean," "appropriate."

**Fix**: Replace each vague word with the specific thing you'd check:
- "good error handling" → "timeouts on external calls, retry with backoff on idempotent ops only, circuit breaking after N failures"
- "clean code" → "functions < 20 lines, no nested callbacks > 2 levels, names describe behavior not implementation"
- "proper testing" → "unit tests for business logic, integration test for the API endpoint, edge cases for empty/null/boundary inputs"

Note: if the criteria sound specific but reference implicit conventions ("follow the project's patterns", "match existing style"), the problem is grounding, not vagueness — see "Grounding" above.

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

### "Ungrounded criteria"

**Symptom**: Criteria use specific-sounding language ("follow the project's conventions", "match existing patterns") but don't name a file, function, or code pattern. The executor cannot evaluate the criterion without exploring the codebase first. (Note: if the criteria use vague adjectives like "good" or "proper", see "Vague criteria" above instead.)

**Test**: Can you name the specific file or function the executor should consult to evaluate this criterion? If not, it's ungrounded.

**Rule of thumb**: If the executor would need to read 5+ files to understand the criterion, it is ungrounded.

**Fix**: Use the grounding pattern above:

1. Look at the criterion — what convention or pattern does it reference?
2. Find the canonical example of that convention in the repo (a file, a function, an interface)
3. Replace the abstract reference with the concrete path + what to look for
4. If you cannot name one canonical artifact, convert the criterion to an automated check or rewrite it narrower
