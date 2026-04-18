# Issue 109: Per-agent `model_hints`

This PR adds an optional top-level `model_hints` object to the relay manifest.
Stored hints are advisory. Runtime consumers in this change are limited to:

- `dispatch.js` via `model_hints.dispatch`
- `review-runner/reviewer-invoke.js` via `model_hints.review`

## Schema

### Before this PR

No `model_hints` field exists at all:

```yaml
---
relay_version: 2
run_id: 'issue-109-20260418091011123-a1b2c3d4'
roles:
  orchestrator: 'codex'
  executor: 'claude'
  reviewer: 'codex'
timestamps:
  created_at: '2026-04-18T00:00:00.000Z'
  updated_at: '2026-04-18T00:00:00.000Z'
---
```

### After this PR: partial (`dispatch` only)

```yaml
---
relay_version: 2
run_id: 'issue-109-20260418091011125-a1b2c3d4'
roles:
  orchestrator: 'codex'
  executor: 'claude'
  reviewer: 'codex'
model_hints:
  dispatch: 'opus'
timestamps:
  created_at: '2026-04-18T00:00:00.000Z'
  updated_at: '2026-04-18T00:00:00.000Z'
---
```

### After this PR: full (`plan` / `dispatch` / `review` / `merge`)

```yaml
---
relay_version: 2
run_id: 'issue-109-20260418091011126-a1b2c3d4'
roles:
  orchestrator: 'codex'
  executor: 'claude'
  reviewer: 'codex'
model_hints:
  plan: 'gpt-5.4-mini'
  dispatch: 'opus'
  review: 'haiku'
  merge: 'gpt-5.4'
timestamps:
  created_at: '2026-04-18T00:00:00.000Z'
  updated_at: '2026-04-18T00:00:00.000Z'
---
```

## Precedence Matrix

| Cell | Consumer | CLI override | Manifest hint | Effective model -> executor argv | Regression test |
| ---- | -------- | ------------ | ------------- | -------------------------------- | --------------- |
| D1 | dispatch | `--model sonnet` | `.dispatch="opus"` | `... -m sonnet ...` | `dispatch precedence D1 regression: CLI override beats manifest hint in executor argv` |
| D2 | dispatch | `--model sonnet` | absent | `... -m sonnet ...` | `dispatch precedence D2 regression: CLI override works when manifest hint is absent` |
| D3 | dispatch | unset | `.dispatch="opus"` | `... -m opus ...` | `dispatch precedence D3 regression: manifest hint supplies the effective model when CLI is unset` |
| D4 | dispatch | unset | absent / `.dispatch` null | NO `-m` token (byte-identical to pre-change) | `dispatch precedence D4 regression: executor argv stays byte-identical when CLI and manifest hint are both absent` |
| R1 | review | `--reviewer-model opus` | `.review="haiku"` | `... --model opus ...` | `reviewer-invoke precedence R1 regression: CLI reviewerModel beats manifest hint in reviewer argv` |
| R2 | review | `--reviewer-model opus` | absent | `... --model opus ...` | `reviewer-invoke precedence R2 regression: CLI reviewerModel works when manifest hint is absent` |
| R3 | review | unset | `.review="haiku"` | `... --model haiku ...` | `reviewer-invoke precedence R3 regression: manifest hint supplies the effective reviewer model when CLI is unset` |
| R4 | review | unset | absent / `.review` null | NO `--model` token (byte-identical to pre-change) | `reviewer-invoke precedence R4 regression: reviewer argv stays byte-identical when CLI and manifest hint are both absent` |

## CLI Failure Modes

Each parser failure prints the exact `console.error` line shown below and exits with status 1.

```text
$ node dispatch.js -b test --model-hints "foo=bar"
Error: invalid --model-hints token 'foo=bar': unknown phase 'foo'
exit 1
```

```text
$ node dispatch.js -b test --model-hints "dispatch"
Error: invalid --model-hints token 'dispatch': missing '='
exit 1
```

```text
$ node dispatch.js -b test --model-hints "=opus"
Error: invalid --model-hints token '=opus': empty phase
exit 1
```

```text
$ node dispatch.js -b test --model-hints "dispatch="
Error: invalid --model-hints token 'dispatch=': empty value
exit 1
```

```text
$ node dispatch.js -b test --model-hints "dispatch=sonnet,,review=opus"
Error: invalid --model-hints token '': empty pair
exit 1
```

```text
$ node dispatch.js -b test --model-hints "dispatch=opus,dispatch=sonnet"
Error: invalid --model-hints token 'dispatch=sonnet': duplicate phase 'dispatch'
exit 1
```

## Event Shape

`events.jsonl` records the effective model on `dispatch_start` and `review_invoke`. The field name is `model`. When no effective model is resolved, the event records JSON `null`.

### `dispatch_start` with populated model (`D3`)

```json
{"ts":"2026-04-18T10:02:31.412Z","event":"dispatch_start","actor":"SJ Lee","run_id":"issue-109-20260418190231412-a1b2c3d4","state_from":"draft","state_to":"dispatched","head_sha":"f2e02379815cbd6c13ca6413ef17cc113aecd7b3","round":null,"reason":"new_dispatch","model":"opus"}
```

### `dispatch_start` with null model (`D4`)

```json
{"ts":"2026-04-18T10:03:44.905Z","event":"dispatch_start","actor":"SJ Lee","run_id":"issue-109-20260418190344905-b2c3d4e5","state_from":"draft","state_to":"dispatched","head_sha":"f2e02379815cbd6c13ca6413ef17cc113aecd7b3","round":null,"reason":"new_dispatch","model":null}
```

### `review_invoke` with populated model (`R3`)

```json
{"ts":"2026-04-18T10:05:18.220Z","event":"review_invoke","actor":"SJ Lee","run_id":"issue-109-20260418190518220-c3d4e5f6","state_from":"review_pending","state_to":"review_pending","head_sha":"abc123","round":1,"reason":"codex","model":"haiku"}
```

### `review_invoke` with null model (`R4`)

```json
{"ts":"2026-04-18T10:06:02.771Z","event":"review_invoke","actor":"SJ Lee","run_id":"issue-109-20260418190602771-d4e5f6g7","state_from":"review_pending","state_to":"review_pending","head_sha":"abc123","round":1,"reason":"codex","model":null}
```

## Scope Reservation

`model_hints.plan` and `model_hints.merge` are persisted but runtime-inert in this PR.
Rationale: runtime consumers = dispatch + review only; plan is orchestrator-driven, merge's gate-check runs in-process.

## Out Of Scope

- Executor-side model-name validation (executor CLI owns unknown-model errors)
- Changes to `--model` / `--reviewer-model` flag semantics (remain overrides; behavior unchanged)
- Wiring plan/merge hints into runtime consumers (stored but inert)
- Sprint-file integration for `model_hints`
- #33 broker pattern / #32 app-server migration (separate issues)
- Probe-executor-env enhancements to list supported models
- Changes to `invoke-reviewer-codex.js` / `invoke-reviewer-claude.js` adapter signatures

## Trust-Model Audit

1. No. `model_hints` is a passive advisory manifest field written by the same dispatch surface that already owns manifest writes.
2. No. Review still evaluates code against the same rubric and Done Criteria; only reviewer model selection changes.
3. No. No authenticated verifier is added or removed, and the event journal remains append-only.
