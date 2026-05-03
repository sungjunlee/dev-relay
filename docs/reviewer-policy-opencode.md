# Reviewer Policy — opencode-produced Work

This document defines the trust policy for opencode executor output before using it broadly. It applies to relay runs where the executor role is bound to opencode (#377), and to advisory artifacts produced by opencode sidecars (#367 epic).

It is policy-as-text. The first pass does not enforce it as a hard merge gate; reviewers and operators apply it manually. Hardening into runtime checks comes later (#379 measurement first, then targeted enforcement).

## Default reviewer for opencode-produced PRs

When the executor is opencode, the default reviewer is **codex** or **claude** — never opencode. This applies to:

- Relay runs (`relay-dispatch -e opencode → relay-review --reviewer codex|claude`).
- Sidecar artifacts (opencode produces advisory output; the human or codex/claude reviewer checks it during the same review pass).

Why codex/claude reviewer is the default:

- opencode is experimental in dev-relay (per #368 trust boundary). Reviewer must be a system the project has already calibrated against the rubric format.
- A different-provider reviewer catches the kind of mistakes a same-family reviewer is statistically prone to miss (mode-collapse, shared training-data blind spots, prompt-injection vulnerabilities).
- The recovery infrastructure (`recover-commit.js`, `force-finalize-nonready`, `rebrand-evidence.js`) is executor-agnostic but assumes a competent reviewer that has produced verdicts the merge gate trusts.

If you have an explicit reason to use opencode as the reviewer (e.g., a stress test of opencode's review fidelity), you must:

1. Land a separate dispatch + review run that uses codex/claude reviewer first.
2. Add the opencode-reviewed run as a parallel verification, not a replacement.
3. Capture both verdicts in the run notes for #379 reliability comparison.

## Same-family executor/reviewer warning

When the executor and the reviewer are the same provider or model family, the review is weaker. The reviewer is more likely to confirm the executor's blind spots than to catch them.

The current matrix:

| Executor | Reviewer | Family relationship | Warn? |
|---|---|---|---|
| codex | codex | same provider (OpenAI) | yes — but codex/codex is the project's calibrated baseline; warn but accept |
| claude | claude | same provider (Anthropic) | yes — same caveat |
| opencode (gpt-*) | codex | same family (OpenAI) | **yes, warn loudly** — opencode routing through OpenAI provider with codex as reviewer is structurally same-model |
| opencode (claude-*) | claude | same family (Anthropic) | **yes, warn loudly** — same logic |
| codex | claude | different provider | preferred |
| claude | codex | different provider | preferred |
| opencode (gpt-*) | claude | different family | preferred |
| opencode (claude-*) | codex | different family | preferred |

Until provider/model metadata is reliably captured (#379 acceptance criteria, depends on #377 manifest fields), the warning is "warn when same provider name appears in both roles." Once #379 lands, the warning extends to "same provider AND same family."

In practice, for opencode runs, **prefer cross-family review pairings**:

- opencode running with an OpenAI provider → review by claude (or by codex with a same-family warning recorded).
- opencode running with an Anthropic provider → review by codex (or by claude with a same-family warning recorded).
- opencode running with a third-party provider (Groq, OpenRouter, local Ollama, etc.) → review by codex or claude, no warning needed.

## What does not count as proof

The following are **proxy signals**, not evidence of correctness, regardless of which executor produced them:

- **opencode self-reports** (e.g., the `resultPreview` field, the model's narrated summary of what it did).
- **PR descriptions** (LLMs write PR bodies that confidently describe code that does not exist).
- **Sidecar outputs** (test-gap scout, context recap, docs-sync drafts). Sidecars are *advisory artifacts* that a reviewer reads as hints; they never replace verdict signals.
- **`tests pass` claims in chat or PR body** without a corresponding execution-evidence stamp.
- **Commit messages** ("Fixed all 3 issues") in isolation.

The proof surface is:

- The diff, read directly.
- The frozen Done Criteria.
- The rubric factor verdicts (signed by the configured reviewer).
- The execution evidence stamp (SHA-bound).
- CI status (test job exit code).

If a reviewer's verdict is overridden by the orchestrator (force-finalize, recover-commit, rebrand-evidence), the override reason must be recorded — same as for codex/claude executors. opencode's experimental status does not unlock weaker audit trails.

## Examples — safe vs. unsafe opencode tasks

### Safe (good fit for opencode executor in first-pass experiments)

- **Refactor with a strong byte-identical contract.** Test infrastructure (PATH-fake binaries, argv capture, full-suite assertions) catches regressions deterministically. Example: #419 / PR #420 (executor adapter contract) succeeded under codex; would also be safe under opencode because the byte-identical matrix is the contract surface.
- **Pure helper extraction.** Move a function from one file to another with no behavior change. Tests assert behavior; review verifies the move is mechanical.
- **Doc-only changes** with a checked rubric (markdown anchor presence, link validity, prose tone). Low blast radius; reviewer confirms structural ACs.
- **Schema additions that are append-only and have a named consumer.** Per `feedback_consumer_first_gate`. Reviewer confirms the consumer reads the new field.
- **Test coverage additions** (new test files, new test cases for existing functions). The verdict is "tests pass + cover the previously-uncovered branch." Easy to verify.

### Unsafe (avoid opencode in first-pass experiments)

- **Auth boundary changes.** Per `feedback_rubric_fail_closed` and the trust-model audit factor in `relay-plan/references/rubric-trust-model.md`. Same-family reviewers may share blind spots about how validation chains compose.
- **State machine changes** that wire a new feature into existing transitions. Per `feedback_rubric_feature_state_matrix` — happy-path-only is the failure mode and same-family reviewers catch this less often.
- **Recovery / fallback paths.** Per `feedback_rubric_unreachable_path_clauses`. Reasoning about reachability is exactly the kind of thing models with shared training data converge on incorrect intuitions about.
- **Schema migrations** with downstream consumers across multiple skills. The cross-skill blast radius makes review fidelity the gating factor; codex/claude review is the calibrated baseline.
- **Prompt template changes** (e.g., `relay/references/prompt-template.md`). Per `feedback_prompt_template_orchestrator_language`. The text shapes future executor behavior; same-family reviewers may be biased toward accepting prompt drift that matches their own internal patterns.
- **Trust-boundary documentation** (this file, for example). Self-evaluation by the same trust system being defined creates a circular validation.

For unsafe categories, default executor is codex or claude. opencode is allowed only as a sidecar (read-only advisory, no commit), reviewed by codex/claude.

## Forward references

- #377: opencode executor adapter (replaces this doc's "first pass" language with concrete enforcement once shipped).
- #379: per-executor reliability — once we have group-by-executor pass-rate / round-count data, the warnings above can be tuned (e.g., raise warning to error if cross-family disagreement is high).
- #367 epic: opencode sidecars — sidecar advisory output is governed by this doc's "what does not count as proof" section.
