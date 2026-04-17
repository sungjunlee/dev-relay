# Cross-Sprint Context

Project-level knowledge that outlives individual sprints. Promoted here from sprint Running Context when it applies beyond one sprint.

## Architecture Decisions

### 2026-04-12 — Wire existing artifacts before adopting external agentic patterns
Sprint: `2026-04-agentic-patterns-phase-0`

When adopting external engineering patterns (e.g., Simon Willison's Agentic Engineering Patterns), check the source ideology first. Willison assumes single-agent memory accumulation. Dev-relay intentionally rejects that model — memory is externalized into manifests, rubrics, PRs, and an independent reviewer.

**Implication**: Patterns that target "agent learns over time" have low leverage here. Patterns that tighten the contract between planner/dispatcher/reviewer/report-consumers have high leverage.

**Concrete rule**: Before adding new signal sources, verify existing artifacts actually flow end-to-end. See `docs/agentic-patterns-adoption.md` for the full reframe.

## Conventions

### Rubric is load-bearing
The rubric is the shared contract between planner, executor, and reviewer. Any feature that depends on rubric content must verify the rubric actually reaches the reviewer (via `anchor.rubric_path`). Otherwise you're building enforcement layers on a missing artifact.

### No autonomy scoring
Probe signals (test frameworks, type strictness, linters) are exposed as data, not inferred behavior. Heuristics like "strict tsconfig = high autonomy" are bad proxies. Use deterministic templates keyed to actual executable checks, not LLM-judged autonomy levels.

### No auto-mutation of shared files
Sprint files and `_context.md` are human-curated. Relay reports candidates at sprint close; humans promote. Auto-append creates stale-review queues.

## Known Gotchas

### `rubric-lifecycle-gap`
Relay rubric was historically ephemeral: generated in orchestrator context, embedded in dispatch prompt, lost after. Reviewer never saw it. This manifests as "enforcement layers built on missing artifacts" anti-pattern. Phase 0 (sprint `2026-04-agentic-patterns-phase-0`) is the fix.

Confidence: 9/10. Source: observed.
Related files: `skills/relay-dispatch/scripts/dispatch.js`, `skills/relay-review/scripts/review-runner.js`, `skills/relay-dispatch/scripts/relay-manifest.js`.

### Reviewer independence is a feature, not a limitation
Willison's patterns assume the same agent remembers and improves over time. Relay's reviewer intentionally runs in fresh context (`context: fork` / `--ephemeral`). Do not add memory to the reviewer. Do not let planning bias leak into review.
