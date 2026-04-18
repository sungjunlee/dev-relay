# Rubric Grandfather Migration

Historical note: `anchor.rubric_grandfathered` was retired in `#190`.

## Historical baseline

Issue `#151` introduced an authenticated migration gate for pre-rubric manifests. That gate used `~/.relay/migrations/rubric-mandatory.yaml` as an operator-owned audit record and stamped migration provenance into `anchor.rubric_grandfathered`.

Issue `#190` removes the runtime meaning of that field. Dispatch, review, and merge now fail closed whenever a retained manifest still carries `anchor.rubric_grandfathered` in any non-`undefined` shape.

## Pre-landing inventory

Verbatim orchestrator-host check before landing `#190`:

```bash
grep -l "rubric_grandfathered" ~/.relay/runs/*/*.md
```

Expected result on the orchestrator host: `0` matches.

## Operator recovery

`~/.relay/migrations/rubric-mandatory.yaml` remains as historical audit evidence only. Runtime code no longer reads it.

If a foreign host still has a retained manifest with `anchor.rubric_grandfathered`:

1. Open the manifest under `~/.relay/runs/<repo-slug>/<run-id>.md`.
2. Remove `anchor.rubric_grandfathered`.
3. Persist a rubric file inside the run directory, typically `~/.relay/runs/<repo-slug>/<run-id>/rubric.yaml`.
4. Set `anchor.rubric_path` to that in-run file.
5. Retry dispatch, review, or merge. If the run is no longer worth repairing, close it with `skills/relay-dispatch/scripts/close-run.js`.

There is no migration CLI after `#190`. Recovery is a manual manifest repair or a terminal close.
