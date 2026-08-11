---
name: relay-review
argument-hint: "[run-id]"
description: Use when a recovered Relay run has an exact PR head and verification proof ready for independent review.
context: fork
compatibility: Requires git, gh CLI, and Node.js 22+; macOS sandbox-exec is required for direct reviewer CLI isolation.
metadata:
  related-skills: "relay, relay-ready, relay-plan, relay-dispatch, relay-merge"
  keywords: "리뷰, 검토, review, exact SHA, fresh context"
---

# Relay Review

## Use when

- `relay-recover inspect` derives the single lifecycle action `review`.
- The durable PR fact, live PR head, passed verification, and frozen Done Criteria all bind to the same commit.
- An independent primary reviewer should produce the next blocking lifecycle fact.

Do not use this skill to plan work, dispatch an executor, repair publication, or merge. Use `relay-plan`, `relay-dispatch`, `relay-recover`, or `relay-merge` respectively.

## Run

```bash
node skills/relay-review/scripts/review-runner.js \
  --repo . \
  --run-id <run-id> \
  --json
```

Optional inputs are `--model <opaque-model>`, `--timeout <seconds>`, repeated
`--credential-env NAME`, and repeated declared
`--credential-file ID=/absolute/source`. `--reviewer` may only repeat the
immutable `run.json` reviewer binding; Relay does not implement mutable
reviewer swaps or routing precedence.

Supported primary-review bindings are Codex, Claude, OpenCode, Pi, Antigravity, and Cursor. Cline remains dispatch-only until its strict review canary is proven. The same flat adapter descriptor used for dispatch declares this capability.

The immutable binding can be repeated explicitly as `--reviewer codex`, `--reviewer claude`, `--reviewer opencode`, `--reviewer pi`, `--reviewer antigravity`, or `--reviewer cursor`. These flags validate the existing binding; they never replace it.

## Runtime contract

The runner:

1. Reads the immutable Relay `run.json` and frozen Done Criteria.
2. Calls canonical `inspect` and requires the derived action `review`.
3. Requires an exact durable/live PR identity, PR head, and passed verification proof for the frozen Done Criteria hash.
4. Builds one review bundle containing only the immutable contract, exact diff, PR identity, and verification fact. It never includes the dispatch prompt, executor transcript, session id, or mutable manifest state.
5. Stages that bundle in an isolated temporary directory and asks the bound adapter for a direct read-only structured-output invocation.
6. Re-enters the per-run lock, repeats inspection, and appends exactly one `review_recorded` fact.
7. Re-inspects and returns the next derived action.

The reviewer returns only:

```json
{"verdict":"pass|changes_requested|escalated","summary":"...","issues":[]}
```

`pass` is stored as `lgtm`; `changes_requested` derives `redispatch`; reviewer invocation or result errors are durably recorded as `escalated`. A runtime invocation failure permits one explicit `review` retry bound to its fact; a second failure fails closed. Model-returned escalation is not retryable. Rounds are derived from prior `review_recorded` facts. There is no automatic loop, review budget, mutable round state, manual verdict application, detached review supervisor, PR-comment authority, or manifest transition.

## Isolation and failure behavior

- Credentials are explicit only: repeat `--credential-env NAME` or a declared
  adapter `--credential-file ID=/absolute/source`. Sources must be canonical,
  owner-only regular files. They are copied into a private staged HOME/XDG tree
  and removed after invocation; GitHub tokens are never inherited.
- Current remote reviewers use `--network-access enabled` (the default); selecting `disabled` fails before invocation. Enabled transport is unrestricted reviewer-process network and does not claim provider-only or tool-network separation.
- macOS uses `sandbox-exec` around the actual reviewer CLI and exposes only staged inputs plus required system/executable paths.
- Linux does not claim direct CLI isolation through Node's permission model; unsupported hosts fail closed.
- A stale PR head, missing verification, changed action, unsupported adapter, or reviewer-binding mismatch writes no review fact.

See [runner notes](references/runner-notes.md) and the [adapter platform](../relay-dispatch/references/agent-adapter-platform.md).
