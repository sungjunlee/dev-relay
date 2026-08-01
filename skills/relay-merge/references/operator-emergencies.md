# Operator Emergencies

These are operator-only emergency paths for relay-merge. The standard merge path lives in `skills/relay-merge/SKILL.md` § 1.

Emergency escape hatch:

```bash
node skills/relay-merge/scripts/finalize-run.js --repo . --run-id "$RUN_ID" --skip-review "hotfix" --json
```

`finalize-run.js --skip-review` bypasses reviewer invocation, so `model_hints.review` is a non-consumer on that path.

#### Operator-only force finalize for non-ready runs

```bash
node skills/relay-merge/scripts/finalize-run.js --repo . --run-id "$RUN_ID" \
  --force-finalize-nonready --reason "review loop exhausted, diff clean per manual inspection" --json
```

Use this only when an operator has independently checked that the PR is mergeable but the manifest cannot reach `ready_to_merge`.
Typical cases: state stuck at `escalated` with a clean diff; primary review unavailable; manifest/PR state desync. If the PR is already MERGED and review PASS audits exist for its head, run plain `finalize-run` instead; it now completes the already-merged recovery without this force flag.
This path is loud on purpose: it records a `force_finalize` event before merge and writes `last_force` into the manifest.
`--force-finalize-nonready` requires `--reason <non-empty-text>`.
`--dry-run` is observation-only on this path: it does not append `force_finalize`.

Do not use it for retry loops.
Do not use it as a test shortcut.
Do not use it to paper over a wrong manifest state that should be repaired instead.

Audit every use:

```bash
jq 'select(.event == "force_finalize")' ~/.relay/runs/<repo-slug>/<run-id>/events.jsonl
```

#### Bootstrap artifact reconciliation

When a run predates an artifact writer that the run itself introduced, use the structured reconciliation command instead of encoding that fact in a force-finalize reason:

```bash
node skills/relay-merge/scripts/relay-reconcile-artifact.js --repo . --run-id "$RUN_ID" \
  --artifact-path "~/.relay/runs/<repo-slug>/<run-id>/execution-evidence.json" \
  --writer-pr 267 --reason "run predates the artifact writer" --json
```

This stamps `bootstrap_exempt` in the manifest, emits `force_finalize` with `bootstrap_exempt: true`, and marks the run merged without invoking the PR merge path.
