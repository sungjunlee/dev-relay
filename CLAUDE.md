# dev-relay

Dispatch an executor, independently review the exact Git result, keep merge
explicit. Relay workflows with explicit merge stop at `ready_to_merge` unless the user explicitly invokes `relay-merge`.

A run is an on-disk record under `~/.relay/runs/` — identity, frozen criteria,
append-only facts, derived next action. Do not reintroduce mutable manifests,
lifecycle tables, evidence sidecars, route catalogs, app registration, a
migration overlay, or a second recovery path. `recover` is the only general
lifecycle writer; dispatch never commits, pushes, opens a PR, or recovers.
Load [docs/architecture.md](docs/architecture.md) to change inspect, recover,
facts, review, merge, host, or adapters.

Append facts through `facts.appendFact`. Re-inspect under `host.withRunLock`
with the same action key. Spawn with argv (`execFileSync`/`spawn`), never an
interpolated `execSync` string. `SKILL.md` ≤150 lines; playbooks in that
skill's `references/`; tests under `tests/<skill>/`. Do not recreate
`docs/archive/`.

Serialize the full gate:

```bash
node --test --test-concurrency=1 tests/*/scripts/*.test.js
```
