---
name: relay-sidecar
description: Run artifact-only advisory sidecars for an existing relay run.
compatibility: Requires relay-dispatch (Epic #367) and Node.js 18+.
metadata:
  related-skills: "relay-dispatch"
  keywords: "사이드카, 보조 검토, sidecar, advisory, artifacts"
  entry: scripts/relay-sidecar.js
---
## Inputs
- Env: `RELAY_ROOT`.
- Input files: retained relay run manifest and PR diff resolved by `--run-id`.
- Scripts: `$RELAY_ROOT/relay-sidecar/scripts/relay-sidecar.js`; relay-dispatch manifest/rubric modules are runtime dependencies.
RELAY_ROOT=${RELAY_ROOT:-${CLAUDE_SKILL_DIR}/..}

# Relay Sidecar

Use `scripts/relay-sidecar.js` to run an advisory sidecar against an existing relay run. The runner resolves the run manifest, sends run context and PR diff text to the configured sidecar executor, and stores the captured stdout under the run's `sidecars/<id>/` directory.

## Entry

```bash
node "$RELAY_ROOT/relay-sidecar/scripts/relay-sidecar.js" --run-id <id> --kind <name> [options]
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

Sidecar output is advisory only and does not count as execution evidence or reviewer proof. This follows the Epic #367 trust model and the opencode policy in `docs/reviewer-policy-opencode.md`.
