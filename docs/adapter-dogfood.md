# Adapter Dogfood Log

Live relay canary runs for executor and reviewer adapter validation. Each entry records
the harnesses, model routes, and phases exercised during a live dispatch→review→merge
cycle. The relay run itself is the arbiter — entries in this log record intent and
configuration, not outcome.

## Pi Adapter Live Relay Canary (Issue #589)

- **Date**: 2026-05-25
- **Issue**: [#589 — Dogfood: Pi adapter live relay canary](https://github.com/sungjunlee/dev-relay/issues/589)
- **Intent**: End-to-end validation of the Pi CLI adapter through a full relay lifecycle
  (plan → dispatch → review → merge) using a docs-only change.
- **Dispatch executor**: `pi` via `opencode-go/deepseek-v4-pro`
- **Primary reviewer**: `pi` via `opencode-go/deepseek-v4-pro`
- **Advisory reviewer**: `opencode` via `opencode-go/deepseek-v4-pro` (OpenCode advisory review)

### Validation Targets

| Target | Description |
| --- | --- |
| CLI invocation | Pi harness launches and responds to the dispatch prompt without adapter errors |
| Result capture | Executor output (commit, PR) is captured by the dispatch adapter contract |
| PR handoff | The resulting PR is addressable by relay-review and relay-merge |
| Review gating | Primary review (Pi) and advisory review (OpenCode) run without adapter failures; verdicts flow into the review manifest |

### Notes

- The change is docs-only (`docs/adapter-dogfood.md`) to keep the blast radius minimal.
- Same-model review pairing (executor and reviewer both `pi` via `opencode-go/deepseek-v4-pro`)
  carries the same-family reviewer warning documented in [reviewer-policy-opencode.md](reviewer-policy-opencode.md).
  The advisory OpenCode reviewer on the same route provides a cross-harness signal.
- Any adapter or runtime failures discovered during the run will be captured as follow-up issues
  rather than hidden.
