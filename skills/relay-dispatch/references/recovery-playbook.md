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

## Known limits of cleanup recovery

These are bounded, deliberate gaps. They are recorded so the cleanup guarantee is
not read as stronger than it is.

- Reviewer cleanup recovery discovers surviving processes by the sealed process
  scope, because the obligation is published before the reviewer child exists and
  therefore cannot name a pid. In-process cleanup reaps the exact process group and
  is unaffected. A reviewer CLI that scrubs its own scope marker and daemonizes can
  therefore outlive a `settled` publication. Credentials it already read are not
  revoked by stage deletion, so this is a liveness and accounting limit, not an
  additional disclosure path.
- The runtime binding is verified before and after execution, but exec resolves a
  pathname, so a swap-and-restore inside that window would run a different image
  than `executed_runtime` attests. Closing this needs exec-by-descriptor, which is
  not reachable from Node and would break signed CLI binaries. The precondition is
  write access to the reviewer CLI's own executable, which already implies control
  of the reviewer.
- A quarantine left behind by a failed removal whose rollback also failed is
  reclaimed on the next recovery by signed `dev`/`ino`, never by pathname. A
  sibling that does not match the signed identity is left untouched.
- Removal itself unlinks a pathname. Node exposes no `unlinkat`, so the verified
  inode cannot be bound to the delete any more than it can be bound to an exec.
  Every path-based step is therefore verified immediately before use, and settling
  additionally depends on a post-condition scan proving no tree carrying the signed
  identity survives under a quarantine name — a rename racing the delete fails
  closed instead of settling. The irreducible residue is a racing rename that also
  moves the tree out of the quarantine namespace; that requires write access to the
  run directory holding the credential stage, which already permits reading the
  staged bytes directly, so it grants no capability the attacker lacks.

The removed `reconcile-run`, `recover-commit`, `recover-state`,
`rebrand-evidence`, and `publish-run` command names remain temporary argv
aliases on `relay-recover.js`. The compatibility parser accepts only the narrow
locator/evidence subset. Retired target-state and force-policy flags fail closed;
no standalone legacy script is installed. Every supported alias invocation is
recorded as typed rollout activity in the repository generation ledger before
canonical inspect/recover runs. If repository identity cannot be resolved for
that observation, the compatibility invocation fails closed instead of becoming
an invisible legacy surface.
