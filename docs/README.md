# Documentation Index

This directory keeps repo-local design notes, issue evidence, operator workflow notes, and historical ledgers that should not ship as installed skill runtime content.

## Stable References

- `relay-lifecycle-manifest-design.md` — manifest lifecycle and same-run control-loop design history.
- `relay-ready-routing-and-handoff-design.md` — readiness routing and handoff model.
- `relay-scenario-tests.md` — scenario-test coverage plan.
- `workflow-lanes.md` — when to use relay, direct implementation, or planning lanes.
- `external-tool-workflow.md` — external review and learning-capture workflow.
- `direct-read-relay-operator-note.md` — operator note for direct relay reads.
- `model-route-policy.md` — provider/model route policy setup for company defaults, personal opt-in, routing rules, advisory reviewers, and sidecars.

## Rubric And Review History

- `rubric-builder-research.md` — rubric-builder research notes.
- `rubric-grandfather-migration.md` — historical migration notes for rubric grandfathering.
- `rubric-fail-closed-history.md` — detailed fail-closed rubric incident ledger. Installed skill guidance is distilled separately in `skills/relay-plan/references/rubric-fail-closed-patterns.md`.
- `relay-resolver-audit-history.md` — resolver-specific audit lineage and call-site rationale.

## Issue Evidence

Files named `issue-*.md` are issue or PR mirrors. Treat them as audit evidence: update links and clarifying notes when paths move, but do not delete or rewrite them just because the issue is closed. `*-plan.md` files are retained when they contain dispatch contracts, acceptance criteria, or reviewer context that differs from the final implementation mirror.

## Cleanup Guidance

- Keep local agent memory out of the repo. The root `memory/` path is ignored; durable lessons should be promoted into `docs/` history files or compact `skills/*/references/` guidance.
- Historical issue evidence may still quote older `memory/*` entry names or absolute orchestrator memory paths. Treat those as incident context, not repo files to recreate.
- Keep installed skill references self-contained. A file under `skills/` should not require `docs/` to be present after `npx skills add`.
- Prefer adding index entries or deprecation notes over moving historical issue files; old PR bodies and sprint logs often point to the original paths.
