---
name: relay-review
argument-hint: "[run-id]"
description: Use when a recovered Relay run has an exact local Git or PR head and verification proof ready for independent review.
context: fork
compatibility: Requires git and Node.js 22+ on a trusted local development host; gh CLI is required only for the retained GitHub route.
metadata:
  related-skills: "relay, relay-ready, relay-plan, relay-dispatch, relay-merge"
  keywords: "리뷰, 검토, review, exact SHA, fresh context"
---

# Relay Review

## Use when

- `relay-recover inspect` derives the single lifecycle action `review`.
- For local delivery, fresh clean Git `HEAD`/tree and the latest passed verification bind to the same commit; no PR or forge observation is required.
- For GitHub delivery, the durable PR fact, live PR head, passed verification, and frozen Done Criteria all bind to the same commit.
- An independent primary reviewer should produce the next blocking lifecycle fact.

The selected route is inherited from the immutable run evidence. Local review
does not fetch, call `gh`, or require forge credentials. GitHub review requires
the exact live PR observation plus the reviewer's explicit adapter network and
credential prerequisites.

Do not use this skill to plan work, dispatch an executor, repair publication, or merge. Use `relay-plan`, `relay-dispatch`, `relay-recover`, or `relay-merge` respectively.

## Run

```bash
node skills/relay-review/scripts/review-runner.js \
  --repo . \
  --run-id <run-id> \
  --json
```

Optional inputs are `--model <opaque-model>` and `--timeout <seconds>`. CLI
authentication and HOME/XDG configuration remain ambient; credential selector
flags are unknown. `--reviewer` may only repeat the
immutable `run.json` reviewer binding; Relay does not implement mutable
reviewer swaps or routing precedence.

Supported primary-review bindings are Codex, Claude, OpenCode, Pi, Antigravity, and Cursor. Cline remains dispatch-only until its strict review canary is proven. The same flat adapter descriptor used for dispatch declares this capability.

The immutable binding can be repeated explicitly as `--reviewer codex`, `--reviewer claude`, `--reviewer opencode`, `--reviewer pi`, `--reviewer antigravity`, or `--reviewer cursor`. These flags validate the existing binding; they never replace it.

## Runtime contract

The runner:

1. Reads the immutable Relay `run.json` and frozen Done Criteria.
2. Calls canonical `inspect` and requires the derived action `review`.
3. Requires either the exact fresh local Git head/tree and passed verification proof, or the exact durable/live PR identity, PR head, and passed verification proof, for the frozen Done Criteria hash.
4. Builds one review bundle containing only the immutable contract, exact diff, delivery identity, and verification fact. It never includes the dispatch prompt, executor transcript, session id, or mutable lifecycle state.
5. Stages that bundle in a private temporary directory and asks the bound adapter for a direct structured-output invocation; immutable staged bytes are checked before and after it runs.
6. Re-enters the per-run lock, repeats inspection, and appends exactly one `review_recorded` fact.
7. Re-inspects and returns the next derived action.

The reviewer returns only:

```json
{"verdict":"pass|changes_requested|escalated","summary":"...","issues":[]}
```

`pass` is stored as `lgtm`; `changes_requested` derives `redispatch`; reviewer invocation or result errors are durably recorded as `escalated`. A runtime invocation failure permits one explicit `review` retry bound to its fact; a second failure fails closed. Model-returned escalation is not retryable. Rounds are derived from prior `review_recorded` facts. There is no automatic loop, review budget, mutable round state, manual verdict application, detached review supervisor, PR-comment authority, or lifecycle transition.

## Execution and failure behavior

- Authentication and HOME/XDG configuration are ambient user-local CLI state.
  Relay does not copy credential files, rewrite HOME/XDG, or serialize auth
  values or source paths. The review input bundle is still separately staged.
- GitHub-route reviewers use `--network-access enabled` (the default); selecting `disabled` fails before invocation. Enabled transport is unrestricted reviewer-process network and does not claim provider-only or tool-network separation. Local review has no forge transport requirement.
- Relay runs directly on the trusted local host. It requests the adapter's native filesystem isolation where available; absent or declaration-only isolation is returned as a non-durable `filesystem_isolation` diagnostic and does not reject review.
- The staged prompt, diff, criteria, schema, and executable bindings are rechecked after invocation. Any mutation or drift yields no review fact.
- A stale PR head, missing verification, changed action, unsupported adapter, or reviewer-binding mismatch writes no review fact.

See [runner notes](references/runner-notes.md) and the [adapter platform](../relay-dispatch/references/agent-adapter-platform.md).
