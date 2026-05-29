# ADR-0004: Review Runner Staged Facade

Status: Accepted (issue #189)

## Context

`review-runner.js` exceeded 1700 lines with host auth, rubric load, prompt build, verdict parse, PR comment, redispatch, and manifest apply interleaved. Auth-boundary and rubric fail-closed logic was hard to audit or test in isolation.

## Decision

Keep `review-runner.js` as a thin **orchestration facade** (~400 lines, `run()` stays here). Stage logic lives under `skills/relay-review/scripts/review-runner/`:

| Module | Concern |
| --- | --- |
| `common.js` | Shared `gh`/`git`/file helpers |
| `context.js` | Host auth, PR/branch/issue resolution, rubric load, diff/done-criteria |
| `prompt.js` | Reviewer prompt assembly |
| `verdict.js` | Parse + validate trusted verdict JSON |
| `comment.js` | PR comment posting |
| `divergence.js` | SHA/diff divergence handling |
| `redispatch.js` | Changes-requested redispatch prompts |
| `manifest-apply.js` | State transitions from verdict |
| `reviewer-invoke.js` | Adapter subprocess invocation |

Public exports (`loadRubricFromRunDir`, `parseReviewVerdict`, etc.) remain re-exported from the facade for existing tests and cross-skill imports (`gate-check.js`).

No review **semantics** changed in #189 — decomposition only.

## Consequences

- Auth and rubric gates belong in `context.js`; do not re-inline them into the facade.
- New review-round steps get a staged owner before the facade grows new function bodies.
- Facade function-count guards (tests) prevent re-monolithing.

## Evidence

- GitHub issue `#189` (post-merge mirror retired after ADR distill)
- Cross-import note: [architecture.md § skills packaging](../../references/architecture.md#skills-is-a-packaging-boundary-not-a-runtime-boundary)
