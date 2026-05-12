# Cross-Skill Install Graph

`npx skills add sungjunlee/dev-relay` is the only operator-supported install path because it places every sibling skill in one directory. Every skill currently reaches across sibling directories through either SKILL.md command paths, JS `require()` calls, or both. Per-skill installs are not supported for operators because they can leave those sibling paths missing and cause module resolution failures.

```
relay ----------> relay-ready
relay ----------> relay-dispatch

relay-ready ----> relay-dispatch
relay-plan -----> relay-dispatch
relay-dispatch -> relay-plan

relay-review ---> relay-dispatch
relay-merge ----> relay-dispatch
relay-merge ----> relay-plan
relay-merge ----> relay-review
relay-sidecar --> relay-dispatch
```

The `relay-dispatch` -> `relay-plan` edge is a small JS-level cycle: `skills/relay-dispatch/scripts/reliability-report.js` imports `../../relay-plan/scripts/tdd-flavor`, while relay-plan scripts and SKILL.md commands call back into relay-dispatch.

| Skill | Required siblings (SKILL.md + JS) | If installed alone | Supported install path |
| --- | --- | --- | --- |
| `relay` | `relay-ready`, `relay-dispatch` | SKILL.md commands reference `../relay-ready/scripts/persist-request.js`, `../relay-ready/scripts/probe-readiness.js`, and `../relay-dispatch/scripts/dispatch.js`; those paths are missing in a relay-only install. | Use `npx skills add sungjunlee/dev-relay` for the full bundle. Per-skill installs are not operator-supported. |
| `relay-ready` | `relay-dispatch` | JS imports fail before request persistence/probing can run: `scripts/persist-request.js` requires `../../relay-dispatch/scripts/cli-args`; `scripts/relay-request.js` requires `../../relay-dispatch/scripts/relay-manifest` and `../../relay-dispatch/scripts/manifest/paths`; `scripts/probe-readiness.js` requires `../../relay-dispatch/scripts/relay-events` and `../../relay-dispatch/scripts/cli-args`. SKILL.md also calls `../relay-dispatch/scripts/dispatch.js`. | Use `npx skills add sungjunlee/dev-relay` for the full bundle. Per-skill installs are not operator-supported. |
| `relay-plan` | `relay-dispatch` | JS imports fail for planning helpers: `scripts/match-template.js` requires `../../relay-dispatch/scripts/manifest/rubric`; `scripts/persist-done-criteria.js` requires `../../relay-dispatch/scripts/manifest/paths` and `../../relay-dispatch/scripts/cli-args`; `scripts/probe-executor-env.js` requires `../../relay-dispatch/scripts/cli-args` and `../../relay-dispatch/scripts/executors`. SKILL.md also calls `../relay-dispatch/scripts/reliability-report.js` and `../relay-dispatch/scripts/dispatch.js`. | Use `npx skills add sungjunlee/dev-relay` for the full bundle. Per-skill installs are not operator-supported. |
| `relay-dispatch` | `relay-plan` | `scripts/reliability-report.js` requires `../../relay-plan/scripts/tdd-flavor`; running reliability reporting from a dispatch-only install fails when relay-plan is absent. This is the closest skill to a root, but it is not fully standalone today. | Use `npx skills add sungjunlee/dev-relay` for the full bundle. Per-skill installs are not operator-supported. |
| `relay-review` | `relay-dispatch` | Review entrypoints and helpers import dispatch manifest/event modules: `scripts/review-runner.js` requires `../../relay-dispatch/scripts/manifest/lifecycle`, `manifest/paths`, `manifest/rubric`, `manifest/store`, `relay-events`, and `cli-args`; nested `scripts/review-runner/*` modules require `../../../relay-dispatch/scripts/...`; reviewer adapters require `../../relay-dispatch/scripts/cli-args`; `scripts/reviewer-helpers.js` and `scripts/analyze-flip-flop-pattern.js` also require dispatch modules. | Use `npx skills add sungjunlee/dev-relay` for the full bundle. Per-skill installs are not operator-supported. |
| `relay-merge` | `relay-dispatch`, `relay-plan`, `relay-review` | Merge scripts import dispatch modules throughout: `scripts/finalize-run.js`, `scripts/gate-check.js`, `scripts/relay-reconcile-artifact.js`, and `scripts/review-gate.js` require `../../relay-dispatch/scripts/...`. `scripts/sprint-close-report.js` additionally requires `../../relay-review/scripts/review-runner/divergence` and `../../relay-plan/scripts/tdd-flavor`, plus dispatch modules. | Use `npx skills add sungjunlee/dev-relay` for the full bundle. Per-skill installs are not operator-supported. |
| `relay-sidecar` | `relay-dispatch` | `scripts/relay-sidecar.js` requires `../../relay-dispatch/scripts/cli-args`, `manifest/paths`, `manifest/store`, `manifest/rubric`, and `sidecar-store`; sidecar execution fails without relay-dispatch installed adjacent. | Use `npx skills add sungjunlee/dev-relay` for the full bundle. Per-skill installs are not operator-supported. |

Keep this file in sync when adding or removing cross-skill script calls. `CLAUDE.md` points users here instead of duplicating the graph.
