# dev-relay

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

**Dispatch an AI executor, independently review the exact result, and keep the
merge decision explicit.**

dev-relay is an orchestrator-agnostic vNext runtime. Each run has one immutable
`run.json`, frozen Done Criteria, append-only facts, and a read-only derived
action. It does not keep a mutable manifest state machine, an execution-evidence
sidecar, route catalog, or app-registration layer.

## Flow

```text
frozen Done Criteria -> dispatch -> inspect -> recover -> independent review -> explicit merge
                                      ^                         |
                                      +------ redispatch --------+
```

`dispatch` only runs the executor in a retained isolated worktree. `inspect`
derives the next action from durable facts and fresh observations. The one
recovery command alone may commit, push, publish a PR, record verification, or
close a run. Review and merge bind the exact current SHA and frozen criteria.
The default `/relay` cycle stops at `ready_to_merge` until you explicitly land it.
Use `/relay-merge` only when you explicitly want to land the reviewed PR.

## Install

```bash
npx skills add sungjunlee/dev-relay
```

Requires Git, Node.js, and authenticated `gh` for PR operations. Local direct
executor/reviewer containment is fail-closed and currently requires working
macOS `sandbox-exec`.

## Quick start

```bash
node skills/relay-dispatch/scripts/dispatch.js . \
  -b feature-auth --prompt-file /tmp/dispatch.md --rubric-file /tmp/rubric.yaml \
  --executor codex --detach --json

node skills/relay/scripts/relay-recover.js inspect --repo . --run-id <id> --json

# Follow inspection.recommended_action. For `recover`:
node skills/relay/scripts/relay-recover.js recover --repo . --run-id <id> \
  --reason "publish work" --expected-action-key <key> --json

# For `review`:
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --json

# For an explicit `merge`:
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

## Migration status

The vNext bootstrap is sealed. A narrow migration overlay remains for legacy
recovery translation and observation until both 30 consecutive zero-legacy-read
days and 30 vNext runs are proven. Current installed dispatch runtime: **18 JS
files / 6,985 LOC**. Post-retirement target: **16 JS files / 5,836 LOC**.

## References

- [Architecture](references/architecture.md)
- [Operator guide](docs/relay-operator-guide.md)
- [Adapter platform](skills/relay-dispatch/references/agent-adapter-platform.md)
- [Runtime inventory](docs/script-inventory-and-cleanup.md)
- [Contributing conventions](CLAUDE.md)

Run the focused suites with Node's test runner, or use the serialized complete
gate documented in `CLAUDE.md`.

## License

MIT
