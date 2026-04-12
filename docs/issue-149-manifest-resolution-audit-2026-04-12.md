# Issue 149 Manifest Resolution Consumer Audit

Scope: `resolveManifestRecord()` changed branch and PR matching semantics. This audit records every current consumer, the selector shape it uses, the failure behavior operators see, and the test that verifies the recovery path.

## Caller Audit

| Consumer | Selector shape | Failure behavior | Operator recovery | Verification |
| --- | --- | --- | --- | --- |
| `skills/relay-dispatch/scripts/dispatch.js` | `--manifest` or `--run-id` only during same-run resume | Missing manifest aborts before executor dispatch | Retry with the correct explicit selector | `dispatch.test.js`: `dispatch resume fails when --run-id does not resolve` |
| `skills/relay-dispatch/scripts/close-run.js` | `--run-id` only | Missing manifest aborts before any state transition or cleanup | Retry with the correct `--run-id` | `close-run.test.js`: `close-run fails when --run-id does not resolve` |
| `skills/relay-dispatch/scripts/update-manifest-state.js` | `--manifest`, `--run-id`, or `--branch` | Ambiguous branch lookup errors instead of mutating an arbitrary run | Re-run with `--run-id` or `--manifest` | `update-manifest-state.test.js`: `update-manifest-state surfaces ambiguous branch resolution with explicit recovery guidance` |
| `skills/relay-review/scripts/review-runner.js` | `--manifest`, `--run-id`, or `--branch` + `--pr` | Terminal-only branch reuse fails closed before review prep starts | Create a fresh dispatch or pass an explicit selector for the intended active run | `review-runner.test.js`: `review-runner fails closed when branch+PR resolution only finds a stale terminal manifest` |
| `skills/relay-merge/scripts/gate-check.js` | PR mode resolves by `branch` + `pr` from `gh pr view` | Resolver failure is surfaced as `manifest_resolution_failed`; first successful legacy resolution stamps `git.pr_number` once | Fresh-dispatch when only terminal runs exist; otherwise rerun after explicit resolution or allow the first-resolution stamp | `gate-check.test.js`: `gate-check PR mode fails closed when only a stale merged manifest exists on the reused branch`, `gate-check resolves and stamps a historical legacy manifest sample with pr_number=null` |
| `skills/relay-merge/scripts/finalize-run.js` | `--manifest`, `--run-id`, or `--branch` + `--pr` | Terminal-only branch reuse blocks merge finalization before any `gh pr merge` call | Create a fresh dispatch or rerun with an explicit selector for the intended active run | `finalize-run.test.js`: `finalize-run fails closed when branch+PR resolution only finds a stale terminal manifest` |

## Historical Compatibility Sample

- Source manifest sampled on 2026-04-12: `~/.relay/runs/finjuice-9621f35f/issue-401-20260412015920920.md`
- Source rubric sampled on 2026-04-12: `~/.relay/runs/finjuice-9621f35f/issue-401-20260412015920920/rubric.yaml`
- Bundle equivalent: `skills/relay-merge/scripts/__fixtures__/historical-issue-401/`
- Verified behavior: a real legacy manifest with `git.pr_number: null` and `anchor.rubric_path: rubric.yaml` still resolves in PR mode, stamps `git.pr_number = 401`, and records a single `pr_number_stamped` event.
