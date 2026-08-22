# dev-relay

Immutable `run.json`, frozen Done Criteria, append-only facts, one derived
action. `recover` is the only general lifecycle writer.

Relay workflows with explicit merge stop at `ready_to_merge` unless the user explicitly invokes `relay-merge`.

**Architecture** ([docs/architecture.md](docs/architecture.md)): inspect,
recover, facts, review, merge, host, or adapters.

Append facts through `facts.appendFact`. Inspect, then re-inspect under
`host.withRunLock` with the same action key. Dispatch records attempts only.
Spawn with argv (`execFileSync`/`spawn`). `SKILL.md` ≤150 lines; playbooks in
that skill's `references/`; tests under `tests/<skill>/`. Do not recreate
`docs/archive/`.

```bash
node --test --test-concurrency=1 tests/*/scripts/*.test.js
```
