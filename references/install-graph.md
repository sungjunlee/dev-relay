# Cross-Skill Install Graph

Install the complete bundle; individual relay skill installs are not supported
because the small phase commands import the shared Relay core.

```bash
npx skills add sungjunlee/dev-relay
```

Set `RELAY_SKILL_ROOT` to the installed sibling root when invoking commands
outside this repository. It defaults to `skills` in a clone.

```text
relay --------> relay-ready, relay-dispatch, relay-review, relay-merge
relay-ready --> relay-dispatch (immutable Done Criteria handoff)
relay-plan ---> relay-dispatch (adapter capability probe / frozen criteria)
relay-review -> relay-dispatch (run-store, facts, host, inspect/recover)
relay-merge --> relay-dispatch (run-store, facts, host, inspect/recover)
relay-fleet --> relay-dispatch, relay-review, relay-merge
relay-config -> relay-dispatch (adapter registry and capability contract)
```

The shared dispatch core is deliberately the sole lifecycle implementation, and
it is all 16 installed files: `dispatch.js`, `run-store.js`, `facts.js`,
`inspect.js`, `recover.js`, `host.js`, `adapter-contract.js`, and `exec.js`,
plus the eight files in `adapters/` (the registry and seven executor
descriptors). No skill may import a legacy manifest facade, event helper,
execution-evidence sidecar, executor-specific registration module, worktree
utility, or migration-overlay module.

| Phase | Entry point | Write authority |
| --- | --- | --- |
| Dispatch | `relay-dispatch/scripts/dispatch.js` | Create immutable run and append attempt facts only. |
| Inspect/recover | `relay/scripts/relay-recover.js` | `inspect` reads; `recover` is the sole convergent lifecycle writer. |
| Review | `relay-review/scripts/review-runner.js` | Append one bound review fact. |
| Merge | `relay-merge/scripts/finalize-run.js` | Explicit, authorized merge fact and safe cleanup. |
| Config | `relay-config/scripts/relay-config.js` | Read-only adapter capability validation. |

All public commands use Node.js and Git; GitHub operations require authenticated
`gh`. Direct local executor/reviewer sandboxing requires macOS `sandbox-exec`.
Unsupported containment hosts fail closed rather than silently widening access.
