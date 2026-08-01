# Recovery Playbook

Relay vNext has one recovery surface. `inspect` is byte-read-only and derives one
typed next action from immutable run facts plus live Git/GitHub observation.
`recover` re-observes under the run lock and converges that action idempotently.

```bash
node skills/relay/scripts/relay-recover.js inspect \
  --repo . --run-id <id> --json

node skills/relay/scripts/relay-recover.js recover \
  --repo . --run-id <id> \
  --expected-action-key <key-from-inspect> \
  --reason "operator explanation" --json
```

Use `--run-dir <absolute-run-dir>` instead of `--repo` and `--run-id` only when
the canonical run directory is already known. Supply `--verification-file`
when the recommended action includes recording verification. Use
`--break-lock` only after `inspect` identifies a stale or unknown owner and the
authenticated terminal-result checks described in the output can succeed.

## Safety contract

- Treat `run.json`, the fact journal, intents, receipts, and merge
  authorizations as writer-owned immutable artifacts; use only canonical
  inspect/recover operations.
- Treat `blockers` as fail-closed. Resolve the reported external condition and
  inspect again; do not force a lifecycle target.
- A CLOSED, unmerged exact PR is an operator decision, not permission to reuse
  or overwrite it. Open or select the intended PR explicitly, then inspect.
- Recovery commits only reviewable Git status paths. Ignored runtime files are
  outside recovery staging; reviewable sockets, FIFOs, and device entries block.
- GitHub merge reconciliation obtains an ephemeral token in the trusted parent
  from `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth login`, and discloses it only to
  the isolated observation process. Reviewer processes never receive it.
- Re-running the same action key returns the durable receipt without repeating
  effects. If live state changed, recovery returns a typed stale-action or
  active-intent blocker.

The removed `reconcile-run`, `recover-commit`, `recover-state`,
`rebrand-evidence`, and `publish-run` command names remain temporary argv
aliases on `relay-recover.js`. The pure translator accepts only the narrow
locator/evidence subset. Retired target-state and force-policy flags fail closed;
no standalone legacy script is installed.
