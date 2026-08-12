# Recovery Utility

Relay Dispatch installs no standalone worktree, cleanup, close-run, or external
provider-health CLI. Those former operator surfaces duplicated lifecycle ownership and
are intentionally retired.

For an interrupted or externally changed run, inspect current facts and apply
only the typed recovery recommendation:

```bash
node skills/relay/scripts/relay-recover.js inspect --repo . --run-id <run-id> --json
node skills/relay/scripts/relay-recover.js recover --repo . --run-id <run-id> \
  --reason "publish the reviewed branch" --json
```

Adapter argv, capability, timeout, outcome-parsing, and no-mutation contracts
belong under `tests/relay-dispatch/`; they use fake executables and are not an
operator-facing provider-health command.
