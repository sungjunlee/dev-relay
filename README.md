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
GitHub revision, record verification, or close a run. Review and merge bind the
exact current SHA and frozen criteria.
The GitHub `/relay` cycle stops at `ready_to_merge` until you explicitly land it;
the local route closes through a Reviewed Result. Use `/relay-merge` only when you explicitly want to land the reviewed GitHub change.

## Install

```bash
npx skills add sungjunlee/dev-relay
```

Requires Git and Node.js. Authenticated `gh` is needed only for the supported
GitHub route; a no-remote Git checkout uses local Reviewed Result delivery.
Local direct executor/reviewer containment is fail-closed and currently
requires working macOS `sandbox-exec`.

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

All current executors are retained: Claude, Codex, OpenCode, Pi, Antigravity,
Cursor, and Cline. The adapter registry gives each a common argv, capability,
and output contract; it does not own lifecycle or registration state. Cline is
dispatch-only until its strict primary-review canary passes.

```bash
node skills/relay-config/scripts/relay-config.js doctor --json
node skills/relay-config/scripts/relay-config.js \
  check --phase dispatch --executor opencode --model provider/model --json
```

## Runtime size

There is one runtime and no migration overlay. The installed package is the
current filesystem below `skills/relay-dispatch/scripts/`; there is no parallel
generated inventory or baseline to reconcile.

## References

- [Architecture](references/architecture.md)
- [Glossary](CONTEXT.md)
- [Operator guide](docs/relay-operator-guide.md)
- [Adapter platform](skills/relay-dispatch/references/agent-adapter-platform.md)
- [Runtime inventory](docs/script-inventory-and-cleanup.md)
- [Contributing conventions](CLAUDE.md)

Run the focused suites with Node's test runner, or use the serialized complete
gate documented in `CLAUDE.md`.

## License

MIT
