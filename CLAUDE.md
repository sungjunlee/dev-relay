# dev-relay

Dispatch an executor, independently review the exact Git result, keep merge
explicit. Relay workflows with explicit merge stop at `ready_to_merge` unless the user explicitly invokes `relay-merge`.

A run is an on-disk record under `~/.relay/runs/` — identity, frozen criteria,
append-only facts, derived next action. `recover` writes lifecycle; dispatch
does not. Load [docs/architecture.md](docs/architecture.md) to change inspect,
recover, facts, review, merge, host, or adapters.

Append facts through `facts.appendFact`. Re-inspect under `host.withRunLock`
with the same action key. Spawn with argv. `SKILL.md` ≤150 lines; playbooks in
that skill's `references/`; tests under `tests/<skill>/`. Do not recreate
`docs/archive/`.

```bash
node --test --test-concurrency=1 tests/*/scripts/*.test.js
```
