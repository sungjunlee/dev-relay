# Recovery Utility

Relay Dispatch installs no standalone worktree, cleanup, close-run, or live
canary CLI. Those former operator surfaces duplicated lifecycle ownership and
are intentionally retired.

For an interrupted or externally changed run, inspect current facts and apply
only the typed recovery recommendation:

```bash
node skills/relay/scripts/relay-recover.js inspect --repo . --run-id <run-id> --json
node skills/relay/scripts/relay-recover.js recover --repo . --run-id <run-id> \
  --reason "publish the reviewed branch" --json
```

Release-only adapter evidence belongs under `tests/relay-dispatch/`; it is not
part of the installed skill surface. The test runner preserves a bounded
read-only adapter canary: CLI probe, invocation, timeout, outcome parsing, and no-mutation
checks for every registered executor.
