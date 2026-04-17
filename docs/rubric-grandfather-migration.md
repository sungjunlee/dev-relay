# Rubric Grandfather Migration

## Migration Manifest Schema

`relay-migrate-rubric.js` reads `~/.relay/migrations/rubric-mandatory.yaml` by default and accepts the following YAML:

```yaml
version: 1
runs:
  - run_id: issue-42-20260412000000000-a1b2c3d4
    registered_by: sjlee
    registered_at: 2026-04-17T08:00:00Z
    reason: "pre-rubric run from 2026-04-10 needed merge after a production hotfix"
    applied_at: 2026-04-17T08:00:05Z
```

`run_id`, `registered_by`, `registered_at`, and `reason` are required. `applied_at` is absent until the migration script stamps the run.

## One-Shot Semantics

Each successful stamp writes object-form provenance into `anchor.rubric_grandfathered`:

```yaml
anchor:
  rubric_grandfathered:
    from_migration: rubric-mandatory.yaml
    applied_at: 2026-04-17T08:00:05Z
    actor: sjlee
    reason: "pre-rubric run from 2026-04-10 needed merge after a production hotfix"
```

The script also writes the same timestamp into the migration manifest entry’s `applied_at`. Future runs of the script skip entries with `applied_at` already set. As a stress-test defense, the script refuses to stamp any run that already carries object-form provenance, even if an operator clears `applied_at` in the migration manifest. That blocks a tamper-then-rerun attempt from silently rewriting audit history.

## Rollout Plan

Issue #138’s audit found zero pre-rubric legacy runs, so the repository ships with an empty migration manifest and the normal path remains `relay-plan` -> `dispatch --rubric-file`. If an exceptional legacy run ever appears, an operator adds one explicit manifest entry with a human justification, runs `relay-migrate-rubric.js`, and keeps the resulting `rubric_migrated` event plus provenance object as the audit trail.

## Deprecation Timeline

Legacy boolean compat (`anchor.rubric_grandfathered: true`) stays read-only for now so old manifests fail open only for audit purposes. `dispatch.js --rubric-grandfathered` is now a warn-and-error alias that points operators to `relay-migrate-rubric.js`. Remove the boolean fallback only in a future tracking issue after the migration manifest stays unused for a full cleanup window and all remaining legacy fixtures are deleted.
