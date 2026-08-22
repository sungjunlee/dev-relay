# Cross-Sprint Context

Project-level knowledge that outlives individual sprints. Promoted here from sprint Running Context when it applies beyond one sprint.

## Architecture Decisions

### 2026-04-12 — Wire existing artifacts before adopting external agentic patterns
Sprint: `2026-04-agentic-patterns-phase-0`

When adopting external engineering patterns (e.g., Simon Willison's Agentic Engineering Patterns), check the source ideology first. Willison assumes single-agent memory accumulation. Dev-relay intentionally rejects that model — memory is externalized into manifests, rubrics, PRs, and an independent reviewer.

**Implication**: Patterns that target "agent learns over time" have low leverage here. Patterns that tighten the contract between planner/dispatcher/reviewer/report-consumers have high leverage.

**Concrete rule**: Before adding new signal sources, verify existing artifacts actually flow end-to-end. See `skills/relay-plan/references/evaluation-channels.md` for the current Outcome Contract, Verification, and Earned Rubric model.

## Conventions

### Outcome Contract and Verification are mandatory
The Outcome Contract is the pass/fail authority: it freezes required results and explicit non-goals in the Done Criteria. Verification is the required evidence channel: executable checks and observable evidence show whether the contract was met but cannot add or relax requirements. Routine test, build, type-check, and lint success belongs to Verification and is not quality value.

Earned Rubric is optional and may have zero factors. Derive a factor only after observing a meaningful quality gradient among contract-satisfying results; do not invent factors to meet a count. Only the independent reviewer scores declared Earned Rubric factors. The executor supplies implementation and Verification evidence, never self-scores quality.

### No autonomy scoring
Probe signals (test frameworks, type strictness, linters) are exposed as data, not inferred behavior. Heuristics like "strict tsconfig = high autonomy" are bad proxies. Use deterministic templates keyed to actual executable checks, not LLM-judged autonomy levels.

### No auto-mutation of shared files
Sprint files and `_context.md` are human-curated. Relay reports candidates at sprint close; humans promote. Auto-append creates stale-review queues.

### Owning sprint resolution is a shared schema-v2 contract
Dev-backlog schema-v2 JSON is the source of truth for sprint ownership. Resolution precedence is an explicit or fleet owner, then the issue `component:`, then the exactly-one-active fallback. Relay consumes this through its shared sprint-state seam and must not add another track/component markdown parser.

One fleet represents one validated track. Every leaf carries the same normalized owner through its child manifest and finalize path; missing, contradictory, ambiguous, or mixed ownership must fail before fleet manifest, issue lock, worktree, or dispatch side effects.

### Operator-surface documentation requires the full repository gate
Adapter selection is explicit CLI input on dispatch and review. Changes to
`docs/README.md` operator surface, any `SKILL.md` wording, the adapter matrix,
or public CLI examples must run the serialized full repository suite because
sibling suites pin the public prose.

## Known Gotchas

### `rubric-lifecycle-gap`
Relay rubric was historically ephemeral: generated in orchestrator context, embedded in dispatch prompt, lost after. Reviewer never saw it. This manifests as "enforcement layers built on missing artifacts" anti-pattern. Phase 0 (sprint `2026-04-agentic-patterns-phase-0`) is the fix.

Confidence: 9/10. Source: observed.
Related files: `skills/relay-dispatch/scripts/dispatch.js`, `skills/relay-review/scripts/review-runner.js`.

### Reviewer independence is a feature, not a limitation
Willison's patterns assume the same agent remembers and improves over time. Relay's reviewer intentionally runs in fresh context (`context: fork` / `--ephemeral`). Do not add memory to the reviewer. Do not let planning bias leak into review.
