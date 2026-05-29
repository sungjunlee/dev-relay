---
name: relay-sidecar
description: Run artifact-only advisory sidecars for an existing relay run.
compatibility: Requires relay-dispatch and Node.js 18+.
metadata:
  related-skills: "relay-dispatch"
  keywords: "사이드카, 보조 검토, sidecar, advisory, artifacts"
  entry: scripts/relay-sidecar.js
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`.
- Files: existing relay run manifest, resolved run context, PR diff text, and generated sidecar output under `sidecars/<id>/`.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-sidecar/scripts/relay-sidecar.js`.

# Relay Sidecar

`relay-sidecar` is an ADVISORY AUXILIARY skill for existing relay runs. It is NOT part of the mandatory plan → dispatch → review → merge lifecycle, and `/relay` does not require a sidecar step.

## Use when

- Running an artifact-only advisory sidecar for an existing relay run
- Capturing supplemental context recap, test-gap, docs-sync, or similar output
- Producing non-gating sidecar artifacts under a run's `sidecars/<id>/` directory

## Do not use when

- Reviewing a PR for the relay gate — use `relay-review`
- Dispatching implementation work — use `relay-dispatch`
- Authoring rubrics or dispatch prompts — use `relay-plan`
- Scouting a subsystem before a run exists or before Done Criteria are frozen — use `relay-plan`'s optional subsystem scout guidance
- Merging or finalizing a PR — use `relay-merge`

The runner resolves the run manifest, sends run context and PR diff text to the configured sidecar executor, and stores captured stdout under the run's `sidecars/<id>/` directory.

## Entry

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-sidecar/scripts/relay-sidecar.js" --run-id <id> --kind <name> [options]
```

## Flags

- `--run-id <id>`: required relay run id.
- `--kind <name>`: required sidecar kind. Known planned kinds include `context-recap`, `test-gap`, and `docs-sync`, but this runner accepts any non-empty string.
- `--executor <name>`: sidecar executor, default `opencode`. This release only wires `opencode`.
- `--model <provider/model>`: optional model override passed through to the executor.
- `--variant <name>`: optional sidecar variant; included in the generated sidecar id.
- `--dry-run`: resolve and print the planned envelope without invoking the executor or emitting sidecar events.
- `--json`: print a structured JSON envelope for the runner response. Executor stdout is still stored as `output.md`.
- `--help`, `-h`: print usage.

## Trust Boundary

Sidecar output is advisory only and does not count as execution evidence or reviewer proof. Use relay-review for gate decisions; sidecar artifacts can inform operators, but they never satisfy implementation, review, or merge proof requirements. Sidecar result events include elapsed/critical-path timing fields and default to `consumed_by_phase=metrics` unless a future orchestrator supplies a narrower phase classification. This follows the opencode policy in `relay-dispatch/references/reviewer-policy-opencode.md`.
