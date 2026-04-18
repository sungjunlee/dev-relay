# Issue 109: Manifest `model_hints`

This change adds an optional top-level `model_hints` object to the relay manifest:

```yaml
model_hints:
  plan: gpt-5.4-mini
  dispatch: opus
  review: haiku
  merge: gpt-5.4
```

Stored hints are advisory. Runtime consumers in this change are limited to:
- `dispatch.js` via `model_hints.dispatch`
- `review-runner/reviewer-invoke.js` via `model_hints.review`

Stored-but-inert fields in this change:
- `model_hints.plan`
- `model_hints.merge`

## Precedence

| Cell | Consumer | CLI override | Manifest hint | Effective model -> executor argv |
| ---- | -------- | ------------ | ------------- | -------------------------------- |
| D1 | dispatch | `--model sonnet` | `.dispatch="opus"` | `... -m sonnet ...` |
| D2 | dispatch | `--model sonnet` | absent | `... -m sonnet ...` |
| D3 | dispatch | unset | `.dispatch="opus"` | `... -m opus ...` |
| D4 | dispatch | unset | absent / `.dispatch` null | NO `-m` token (current behavior) |
| R1 | review | `--reviewer-model opus` | `.review="haiku"` | `... --model opus ...` |
| R2 | review | `--reviewer-model opus` | absent | `... --model opus ...` |
| R3 | review | unset | `.review="haiku"` | `... --model haiku ...` |
| R4 | review | unset | absent / `.review` null | NO `--model` token (current behavior) |

`dispatch.js --model-hints` persists hints on new runs. On same-run resume (`--run-id` or `--manifest`), it replaces the existing manifest object and emits a `model_hints_updated` event with `{ before, after }`.

`dispatch.js --dry-run` resolves the effective dispatch model for plan output, but it does not write the manifest and it does not emit events.

## Parse Gate

The only new fail-closed validation surface is the `--model-hints` CLI parser. Exact messages:

1. `Error: invalid --model-hints token 'foo=bar': unknown phase 'foo'`
2. `Error: invalid --model-hints token 'dispatch': missing '='`
3. `Error: invalid --model-hints token '=opus': empty phase`
4. `Error: invalid --model-hints token 'dispatch=': empty value`
5. `Error: invalid --model-hints token '': empty pair`
6. `Error: invalid --model-hints token 'dispatch=sonnet': duplicate phase 'dispatch'`

Parse failures do not partially apply changes and do not write the manifest.

## Events And Reporting

`events.jsonl` now records the effective model on:
- `dispatch_start`
- `review_invoke`

The field name is `model`. When the effective model is unset, the event records `"model": null`.

`reliability-report.js` now aggregates:

```json
{
  "model_per_phase": {
    "dispatch": {
      "null": 1,
      "opus": 2
    },
    "review": {
      "haiku": 2,
      "null": 1
    }
  }
}
```

## Non-Consumers

These paths do not invoke an executor or reviewer and therefore do not consume `model_hints`:
- `finalize-run.js --skip-review`
- `gate-check.js --skip`

## Trust-Model Audit

1. Forge gate: No. `model_hints` is a passive advisory manifest field written by the same dispatch surface that already writes manifests.
2. Verifier gate: No. Review still evaluates code against the same rubric and Done Criteria. Only the model selection changes.
3. External verifier: No. No authenticated check is added or retired. The event journal remains append-only.
