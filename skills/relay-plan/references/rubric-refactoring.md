# Rubric — Refactoring

Metrics a senior engineer actually checks when refactoring. Not "does it still work" but "is the codebase genuinely simpler, or did you just move the mess around."

## Prerequisites (Hygiene)

Use this section only for checks that would apply to ANY PR in this repo. They gate the run and do not count toward factor totals.

| Check | Command | Target | Why it matters |
|-------|---------|--------|----------------|
| Behavior preservation | Project test suite (full) | exit 0, same pass count | Repo-wide hygiene for safe edits. Keep it in `prerequisites`, not `factors`. |
| Lint / type floor | `npx eslint --max-warnings 0` or `tsc --noEmit` | exit 0 | Generic safety baseline, not proof that the refactor simplified anything. |

## Automated Checks (Contract-tier)

These stay in `factors` because they verify a SPECIFIC AC item is implemented.

| Factor | Tier | Command | Target | Why it matters |
|--------|------|---------|--------|---------------|
| Dead code eliminated | `contract` | `npx knip --no-exit-code \| wc -l` or `npx ts-prune \| wc -l` | ≤ baseline | If you refactored and dead code increased, you added new waste while reorganizing old waste. |
| Type coverage | `contract` | `npx type-coverage --at 80` | ≥ baseline % | Refactoring is the best time to tighten types. If coverage dropped, you traded one risk for another. |
| Complexity delta | `contract` | `npx complexity-report --format json` or project linter | ≤ baseline | Cyclomatic complexity is crude but directional. If it went up, the code got harder to reason about. |
| Dependency direction | `contract` | `npx madge --circular src/` | 0 circular dependencies | Circular dependencies are the #1 sign of tangled architecture. Refactoring should break cycles, not create them. |

## Evaluated Factors

These separate "reorganized" from "genuinely simplified."

### Concept reduction (target: ≥ 8/10)

tier: quality

The measure of simplicity is not lines of code — it's the number of concepts a reader must hold in their head simultaneously.

- **Fewer moving parts**: After the refactor, does a developer need to understand fewer things to modify this area? Count the types, abstractions, and indirection layers. If the number went up, the refactor added complexity in the name of "organization."
- **Abstractions earning their keep**: Every abstraction is a tax on readability. A `BaseService` with one subclass, a `Strategy` pattern with one strategy, a `Factory` that creates one type — these are complexity theater. Kill them.
- **Naming as documentation**: After refactoring, can you read the code top-to-bottom and understand the flow without jumping to definitions? If variable names went from `data` to `unvalidatedUserInput`, that's a win. If they went from `handler` to `AbstractRequestProcessorDelegate`, that's a loss.

Scoring guide:
- **low**: More abstractions after than before, indirection layers added without removing others, concepts scattered across more files.
- **mid**: Abstractions reduced but naming still unclear, or file count lower but concepts per file increased.
- **high**: Fewer moving parts, abstractions earn their keep, code reads top-to-bottom without jumping to definitions.

### Dependency hygiene (target: ≥ 8/10)

tier: quality

The direction and depth of dependencies reveal the real architecture.

- **Stable things don't depend on unstable things**: Core business logic depending on a UI framework, a database adapter, or a specific HTTP library is a coupling bomb. After refactoring, do the dependency arrows point toward stability?
- **Import depth**: If modifying one module requires understanding a chain of 6 imports to reach the actual logic, the module boundaries are wrong. Good refactoring shortens these chains.
- **Explicit over implicit**: After refactoring, are dependencies injected or imported clearly? Or are they hidden in global state, service locators, or magic that requires institutional knowledge to understand?

Scoring guide:
- **low**: Business logic imports framework internals, dependency chains deeper than before, hidden coupling via shared mutable state.
- **mid**: Dependency arrows point toward stability, but some imports still cross boundary layers; explicit > implicit partially achieved.
- **high**: Stable core has zero framework imports, dependency chains shorter, all dependencies explicit and injected.

### Seam quality (target: ≥ 7/10)

tier: quality

A seam is where you can change behavior without modifying existing code. Good refactoring creates seams at the right boundaries.

- **Testability as a side effect**: If the code is now easier to test without mocks, the seams are in the right place. If you need more mocks after refactoring, the boundaries are wrong.
- **Change locality**: For the most likely future changes in this area, how many files would need to be modified? If the answer went up, the refactor optimized for today's structure, not tomorrow's changes.
- **Rollback safety**: Can the old behavior be restored quickly? Refactoring that burns the bridge (deletes old code, removes compatibility) before the new path is proven is a gamble.

Scoring guide:
- **low**: Testing requires more mocks than before, likely changes would touch more files, no way to partially roll back.
- **mid**: Testable without mocks in most cases, change locality improved, but rollback path not considered.
- **high**: Fewer mocks needed, likely future changes localized to 1-2 files, rollback path exists and is documented.

### Deletion courage (target: ≥ 7/10)

tier: quality

The best code is deleted code. Refactoring is the rare moment when deletion is expected and welcome.

- **Actually removed**: "Deprecated" is not "deleted." Commenting out is not deleting. If the old code is still there with `// TODO: remove` or `@deprecated`, the refactoring isn't done.
- **No compatibility shims without sunset**: If you kept the old interface "for compatibility," when does it die? A shim without a removal date is permanent complexity.
- **Config and feature flags cleaned up**: Dead feature flags, unused environment variables, config keys that nothing reads — these are invisible clutter. Refactoring should clean the edges, not just the center.

Scoring guide:
- **low**: Old code commented out instead of deleted, unused exports/types retained "just in case," dead config entries left behind.
- **mid**: Old code deleted, but compatibility shims or deprecated markers remain without sunset dates.
- **high**: Dead code fully removed, no shims without sunset dates, config and feature flags cleaned up.

## Tool → Automated Check Mapping

| Tool | Automated check | Replaces evaluated |
|------|----------------|-------------------|
| TypeScript / `tsc` | `tsc --noEmit` → exit 0 | Type safety after refactor |
| eslint | `npx eslint --max-warnings 0` → exit 0 | Code quality baseline |
| knip / ts-prune | `npx knip` → 0 unused exports | Dead code removal (partial) |
| madge | `npx madge --circular src/` → 0 circular | Dependency direction |
| Jest / Vitest | `npm test` → exit 0 | Behavioral equivalence |
