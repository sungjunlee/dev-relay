# dev-relay

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

**Dispatch an AI executor, independently review the exact result, and keep the
merge decision explicit.**

dev-relay is an orchestrator-agnostic Relay runtime. Each run has one immutable
`run.json`, frozen Done Criteria, append-only facts, and a read-only derived
action. It does not keep mutable lifecycle state, an execution-evidence
sidecar, route catalog, or app-registration layer.

## Flow

```text
frozen Done Criteria -> dispatch -> inspect -> recover -> independent review
                                      ^                         |
                                      +------ redispatch --------+
                                                     |
                              local Reviewed Result / ready_to_merge -> explicit GitHub merge
```

`dispatch` only runs the executor in a retained isolated worktree. The public
route first requires Git and classifies the source: no configured remote uses
local Reviewed Result delivery, while an identity-matching GitHub source keeps
the existing PR route. `inspect` derives the next action from durable facts and
fresh observations. The one recovery command alone may commit, publish a
GitHub revision, record verification, or close a run. Recovery is also the
routine publication and verification conveyor: 96% of `recovery_applied`
events serve the routine conveyor, with crash convergence a measured small
subset (2026-08-15 reading). Review and merge bind the exact current SHA and
frozen criteria.
The GitHub `/relay` cycle stops at `ready_to_merge` until you explicitly land it;
the local route closes through a Reviewed Result. Use `/relay-merge` only when you explicitly want to land the reviewed GitHub change.

## Install

```bash
npx skills add sungjunlee/dev-relay
```

Requires Git and Node.js. Authenticated `gh` is needed only for the supported
GitHub route; a no-remote Git checkout uses local Reviewed Result delivery.
Executors and reviewers run directly on the trusted local host on every
supported OS. Relay requests a CLI's native filesystem control where available
and otherwise returns a nonblocking capability diagnostic; it is not a
multi-tenant sandbox. Immutable contained review inputs, runtime binding, and
post-run revalidation remain fail-closed.

## Quick start

```bash
node skills/relay/scripts/run-preflight.js \
  --stage route --repo . --issue-number <N> --branch issue-<N> --json

node skills/relay-dispatch/scripts/dispatch.js . \
  -b feature-auth --prompt-file /tmp/dispatch.md --rubric-file /tmp/rubric.yaml \
  --executor codex --detach --json

node skills/relay/scripts/relay-recover.js inspect --repo . --run-id <id> --json

# Follow inspection.recommended_action. For `recover`:
node skills/relay/scripts/relay-recover.js recover --repo . --run-id <id> \
  --reason "publish work" --expected-action-key <key> --json

# For `review`:
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --json

# On the GitHub route, for an explicit `merge`:
node skills/relay-merge/scripts/finalize-run.js --repo . --run-id <id> --json
```

## Executors

Codex is the default route — recent real usage is 38 of 52 runs `codex|codex`,
with non-codex executor runs serving as adapter dogfood. Claude, Codex,
OpenCode, Pi, Antigravity, Cursor, and Cline are all retained; select one with
dispatch `--executor` and an optional `--model`. The adapter registry gives
each a common argv, capability, and output contract; it does not own lifecycle
or registration state. Cline is dispatch-only because it has no registered
structured primary-review output contract. A missing CLI fails closed as
`executable not found`.

## Runtime size

There is one runtime and no migration overlay. The installed package is the
current filesystem below `skills/relay-dispatch/scripts/`; there is no parallel
generated inventory or baseline to reconcile.

## References

- [Architecture](references/architecture.md)
- [Glossary](CONTEXT.md)
- [Operator guide](docs/relay-operator-guide.md)
- [Adapter platform](skills/relay-dispatch/references/agent-adapter-platform.md)
- [Contributing conventions](CLAUDE.md)

Run the focused suites with Node's test runner, or use the serialized complete
gate documented in `CLAUDE.md`.

## License

MIT
