# Rubric Design Guide

How to synthesize a task-specific evaluation rubric from the full task brief. Acceptance Criteria (AC) are high-priority evidence, not the only source. When AC are missing, vague, or incomplete, first recover observable Done Criteria from task intent, repo context, quality signals, and risk.

Before dispatch, persist the finished rubric to a file and pass it through `relay-dispatch --rubric-file <path>`. This records `anchor.rubric_path` for review and merge gates.

## Reference Use Contract

The domain `rubric-*.md` files are **candidate axis libraries**, not dispatch templates. Use them to sharpen task-specific judgment:

- Pick only the axes earned by task-specific evidence: explicit AC, inferred Done Criteria, repo conventions, historical signal, probe signal, or concrete risk.
- Do not copy a whole domain reference into a dispatch prompt.
- S-size mechanical tasks may use one contract factor plus hygiene prerequisites and no quality factor.
- Add quality factors only when the task has real design judgment or risk that a command cannot verify.
- Treat `fix_hint` examples as optional escalation aids for historical plateaus or non-obvious score transitions, not default implementation instructions.

## Factor Fields

Common factor fields are:

- `name`: short label used by the Score Log and reviewer
- `tier`: `contract` or `quality`
- `type`: `automated` or `evaluated`
- `command`: immutable command for automated factors
- `criteria`: concrete inspection criteria for evaluated factors
- `target`: pass condition such as `exit 0`, `< 200ms`, or `>= 8/10`
- `weight`: `required` or `best-effort`
- `baseline` / `setup`: optional commands for before-state or preparation
- `scoring_guide`: low/mid/high anchors for evaluated factors
- `fix_hint`: optional directed iteration aid for known plateau patterns

Reviewer verdicts record numeric quality scores separately from pass/fail state: `score` is the reviewer-observed 0-10 value, `target_score` is the numeric target when one exists. Contract factors usually leave both numeric fields `null`; quality factors with targets such as `>= 8/10` should produce `score: 7.5, target_score: 8` until they meet target.

Optional TDD factor fields:

```yaml
rubric:
  factors:
    - name: Parser handles malformed input
      tier: contract
      type: automated
      command: "node --test tests/parser.test.js"
      target: "exit 0"
      weight: required
      tdd_anchor: "tests/parser.test.js"
      tdd_runner: "node:test"
```

`tdd_anchor: <path-string>` is a per-factor opt-in. Its presence means the dispatch prompt inserts Step 0a for that factor. Do not add a top-level `tdd_mode`.

`tdd_runner: <jest|pytest|mocha|vitest|...>` is an optional companion. If it is omitted, the executor falls back to the first `test_infra` entry from `probe-executor-env.js --project-only --json`. If no test infra is reported, the executor stops before Step 0a with a clear error.

Use `tdd_anchor` only when red-first testing fits the factor's contract: crisp behavior, a specific path, and a runner that can target that path. Leave documentation, prose, UI judgment, and broad design factors without `tdd_anchor`.

## Guided Interview

Walk through these questions to design a task-specific rubric. Stop when the rubric covers the recovered Done Criteria without adding generic quality wishes.

### Q1: What is the evaluation source model?

List the evidence that defines success for this task:

- Explicit AC, if present
- Inferred Done Criteria from the user request, issue body, relay-ready handoff, and nearby repo conventions
- Repo quality signals from available tests, lint, typecheck, CI, and scripts
- Historical relay signals such as stuck factors, score divergence, and average rounds
- Task risk such as trust boundaries, data loss, migrations, user-visible flows, performance, or operational failure modes

If explicit AC and inferred Done Criteria disagree, resolve the conflict before drafting factors. Run the [pre-flight ambiguity audit](dc-preflight-audit.md) before freezing the Done Criteria, then persist planner-authored Done Criteria when the final anchor differs from the issue body or intake handoff.

### Q2: What actually matters for this task?

Rank the outcomes that would hurt most if they shipped wrong. Each kept concern must pass the tier test:

| Tier | Question | Placement | Examples |
|---|---|---|---|
| Hygiene | Would this apply to any PR in this repo? | `prerequisites` | `npm test`, `tsc --noEmit`, repo lint |
| Contract | Does this verify a specific Done Criteria outcome exists? | `factors` | endpoint returns pagination metadata, config accepts a new field |
| Quality | Does this judge how well the implementation is designed? | `factors` | failure-mode strategy, abstraction boundary, reader success |

Contract is "is it there?" Quality is "is it good?" Move repo-wide checks to `prerequisites`; do not count them as substantive factors.

### Q3: What can be measured with a command?

Inventory project tools before deciding what is measurable:

```bash
${CLAUDE_SKILL_DIR}/scripts/probe-executor-env.js <repo-path> --project-only --json
```

For each Done Criteria item, ask whether a shell command can verify the outcome with available tools.

- Yes: make it an automated factor with an immutable `command` and concrete `target`.
- No: make it an evaluated factor and continue to Q4.

Examples:

| Done Criteria item | Measurable command | Factor type |
|---|---|---|
| API responds within 200ms | `curl -w '%{time_total}'` | automated |
| links in one doc work | `npx markdown-link-check <file>` | automated |
| graceful error handling | requires reading code paths | evaluated |
| clean component boundaries | requires judgment | evaluated |

Automated does not automatically mean substantive. `npm test` is hygiene unless the command directly targets this task's changed behavior.

### Q4: What would a specialist check?

For each evaluated factor, write criteria specific to this task. A useful evaluated factor names what to inspect, not a vague standard.

Good criteria:

- name concrete files, functions, commands, user flows, or data shapes
- use 3-5 bullets
- distinguish required outcomes from nice-to-have polish
- avoid helper names, exact line counts, or internal control flow unless the Done Criteria explicitly requires them

Consult domain references only after drafting from task-specific evidence. Borrow the thinking, not the whole checklist.

### Q5: What does each score level mean?

Every evaluated factor needs a `scoring_guide` with low/mid/high anchors.

```yaml
scoring_guide:
  low: "No timeouts on external calls, retry-on-everything, errors swallowed"
  mid: "Timeouts exist but retry/backoff and caller-actionable errors are incomplete"
  high: "Timeouts, idempotency-aware retry, backoff, and actionable errors all present"
```

Use one sentence per level. If low/mid/high are hard to distinguish, the factor is too broad or too vague.

Add `fix_hint` only when anchors are not enough, usually because historical signals show a plateau or the mid-to-high transition requires a non-obvious technique:

```yaml
fix_hint:
  low_to_mid: "Add timeouts to all external HTTP/DB calls; gate retries behind idempotency"
  mid_to_high: "Add exponential backoff with jitter and structured caller-actionable errors"
```

### Q6: Is there a baseline?

For delta metrics such as performance, bundle size, complexity, or dead code, target the current state instead of an arbitrary number.

- Define a `baseline` command.
- Frame targets as `<= baseline`, `<= baseline + 10%`, or another explicit threshold.
- Skip baselines for absolute checks such as `exit 0`, `0 violations`, or new behavior with no before-state.

## Size Guidance

Use task size to limit, not inflate, the rubric:

| Size | Contract min | Quality min | Recommended substantive total |
|---|---:|---:|---:|
| S mechanical | 1 | 0 | 1-2 |
| S design-bearing | 1 | 1 | ~2 |
| M | 2 | 1 | ~5 |
| L | 2 | 2 | ~6 |
| XL | 3 | 2 | ~8 |

Warn at 8+ substantive factors. Usually that means overlap, hygiene left in `factors`, or task scope that should be split.

## Grounding

Evaluated criteria must point to discoverable artifacts. If the executor would need to read 5+ files to understand a criterion, ground it or convert it to an automated check.

| Ungrounded | Grounded |
|---|---|
| "follow project error handling conventions" | "match `src/errors.ts` and wrap async handlers with the existing `AppError` pattern" |
| "consistent API style" | "match the response shape in `src/routes/users.ts`: `{ data, meta, errors }`" |
| "matches component patterns" | "follow `src/components/UserCard.tsx`: props interface, named export, co-located test" |

## Atomic-revert factor wording

When a rubric factor scores commit count or commit-per-item structure (the "atomic-revert" check, often F2), avoid wording that prescribes an EXACT count. The orchestrator-correction flow — where R1 finds a real bug, the orchestrator hand-fixes and pushes a +1 commit, and R2 re-reviews — is a first-class flow (see `skills/relay-dispatch/references/recovery-playbook.md` § "Recovery command boundaries"). Strict "exactly N" wording forces a `--force-finalize-nonready` for every legitimate R1 catch.

Anti-pattern (forces force-finalize on every R1 fix cycle):

```yaml
- name: Atomic-revert preserved
  type: evaluated
  criteria: "Exactly N commits, one per AC item, no fix-up commits."
  target: ">= 8/10"
```

Recommended — allow one R1-fix commit explicitly:

```yaml
- name: Atomic-revert preserved
  type: evaluated
  criteria: >
    >= N commits with one optional R1-fix-commit allowance.
    Atomic-revert preserved in practice — `git revert <fix-sha> <original-sha>`
    reverts <item> as a unit. Orchestrator-correction commits per
    recovery-playbook.md are legitimate and do not violate this factor.
  target: ">= 8/10"
  scoring_guide:
    low: "Single squashed commit; revert removes everything."
    mid: "N or N+1 (with documented R1 fix) commits; multi-commit revert works."
    high: "N commits, one per AC item, no fix-up needed; R1 was clean."
```

The N+1 affordance applies only to commits whose subject describes an R1-feedback fix. New AC scope shipped as fix-up commits is still graded down.

Two dogfood data points (#316 Sub B PR #342 and #316 Sub A PR #343, same session) hit this exact pattern: R1 found a real substantive bug, orchestrator-correction added a +1 commit, R2 flagged F2 fail despite F3 PASS + green CI. Both required `--force-finalize-nonready` to merge. Below rule of three, but the pattern is intrinsic to the orchestrator-correction flow — fold this affordance into new rubrics rather than waiting for a third instance.

### Force-finalize-nonready provenance template

When R2 fails F2 only on commit count after a bug-fix cycle AND F3 (substantive) passes AND CI is green at HEAD, force-finalize is the right response. Cite all four:

> "R2 confirmed F3 [substantive] PASS but flagged F2 [commit count] — R1 fix `<sha>` is a Nth commit. Same orchestrator-correction-becomes-extra-commit pattern as `<prior PR if any>`. CI green at HEAD `<sha>` (test pass <s>s visible in `gh pr checks <pr>`). Atomic-revert preserved in practice — `git revert <fix-sha> <original-sha>` reverts <item> as a unit."

Rebase-fold to merge the fix into the original commit is technically cleaner but requires force-push and a fresh review round; cost rarely beats benefit for procedural-only blockers.

## What Lives Elsewhere

- Validation checklist, quality card, grades, and risk signals: `rubric-validation.md`
- Simplification heuristics for removing over-prescriptive rubric language: `rubric-simplification.md`
- L/XL ambiguity review and calibration simulation: `rubric-stress-test.md`
- Planner input signals: `signals.md`
- Domain candidate axes: `rubric-backend.md`, `rubric-frontend.md`, `rubric-security.md`, `rubric-refactoring.md`, `rubric-documentation.md`, `rubric-design.md`
- Special patterns: `rubric-trust-model.md`, `rubric-pattern-event-shape.md`, `rubric-pattern-tdd-flavor.md`, `rubric-pattern-grep-token-precision.md`, `rubric-pattern-forbidden-zones.md`
