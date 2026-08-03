# dev-relay contributor guide

dev-relay is an orchestrator-agnostic vNext relay runtime. The current model is
an immutable `run.json`, frozen Done Criteria, append-only facts, and a derived
action. Do not reintroduce mutable manifests, lifecycle transition tables,
execution-evidence sidecars, route catalogs, app registration, or a second
recovery path.

Historical files below `docs/archive/` are evidence only.

Relay workflows with explicit merge stop at `ready_to_merge`; this means stopping at `ready_to_merge` unless the user explicitly invokes `relay-merge`.

## Runtime shape

```text
skills/relay-dispatch/scripts/
  dispatch.js              create/redispatch executor attempts
  inspect.js               pure fact fold -> one typed action
  recover.js               production observer + idempotent recovery/close
  run-store.js             immutable run/artifact trust boundary
  facts.js                 append-only facts + merge authorization
  host.js                  lock, detached host, cancellation, sandbox
  adapter-contract.js, exec.js
  adapters/                registry + seven retained native executors
```

Installed: 16 JS / 6,028 LOC. The figure is generated into
`tests/ledger/vnext-baseline.generated.json`; refresh it with the ledger
generator rather than editing it by hand.

vNext is the only writer. There is no migration overlay, no writer generation,
no admission capability, and no retirement gate; a run directory is claimed by a
non-recursive `mkdir`. Pre-vNext manifests are unreadable and `relay-recover`
exposes only `inspect` and `recover`. Do not reintroduce any of it.

The seven executors are Claude, Codex, OpenCode, Pi, Antigravity, Cursor, and
Cline. Add an executor as one `adapters/<name>.js` four-method descriptor,
register it in `adapters/index.js`, and update adapter tests/docs. Do not give
an adapter its own state, publisher, worktree utility, or registration hook.

## Required invariants

- Validate immutable input bytes and regular-file containment before use.
- Facts append through `facts.appendFact`; never rewrite `events.jsonl`.
- Inspect before a write and re-inspect under the run lock with the same action
  key. `recover` is the only general lifecycle writer.
- Host locks and host audits are capabilities; use `host.withRunLock` rather
  than hand-editing ownership artifacts.
- Dispatch never commits, pushes, opens a PR, or runs recovery.
- Review is bound to immutable reviewer, exact live PR SHA, passed verification,
  and Done Criteria. Merge has no bypass and is explicit.
- Scripts use argv-based `execFileSync`/`spawn`, never interpolated shell
  `execSync` strings.

## Validation

Run scoped tests for each touched skill. Before a broad change, serialize the
full gate:

```bash
node --test --test-concurrency=1 \
  tests/relay-ready/scripts/*.test.js tests/relay-plan/scripts/*.test.js \
  tests/relay-dispatch/scripts/*.test.js tests/relay-review/scripts/*.test.js \
  tests/relay-merge/scripts/*.test.js tests/relay/scripts/*.test.js \
  tests/relay-config/scripts/*.test.js tests/relay-fleet/scripts/*.test.js \
  tests/skills-lint/scripts/*.test.js
```

Regenerate/check inventories from the real filesystem; never hand-edit a green
result without running its generator:

```bash
node tests/skills-lint/scripts/vnext-test-ledger.js generate
node tests/skills-lint/scripts/vnext-test-ledger.js check
node tests/skills-lint/scripts/vnext-runtime-inventory.js .
```

Test files and fixtures belong under `tests/<skill>/`, not `skills/`. Keep each
`SKILL.md` under 150 lines and move operator playbooks to `references/`.
