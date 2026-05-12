# Cross-Skill Install Graph

`npx skills add sungjunlee/dev-relay` is the turnkey install because it places every sibling skill in one directory. Per-skill installs also work with `npx skills add sungjunlee/dev-relay/<skill>`, but skills that call sibling `scripts/` need those siblings installed adjacent with the expected names.

```
relay --------+--> relay-ready --> relay-dispatch
              +--> relay-dispatch

relay-plan ------> relay-dispatch

relay-review      relay-merge      relay-sidecar
   standalone       standalone       standalone
```

| Skill | Transitively requires sibling `scripts/` | If installed alone | Supported install path |
| --- | --- | --- | --- |
| `relay` | `relay-ready`, `relay-dispatch` | Readiness persistence/probe and dispatch calls fail when those sibling script paths are missing. | Full repo install works; per-skill works only if `relay-ready` and `relay-dispatch` are also installed adjacent. |
| `relay-ready` | `relay-dispatch` | Continuation paths that call `relay-dispatch/scripts/dispatch.js` fail. | Full repo install works; per-skill works only if `relay-dispatch` is also installed adjacent. |
| `relay-plan` | `relay-dispatch` | Dispatch and reliability-report calls fail. | Full repo install works; per-skill works only if `relay-dispatch` is also installed adjacent. |
| `relay-dispatch` | None | Nothing - standalone. | Full repo install works; per-skill install works alone. |
| `relay-review` | None | Nothing - standalone. | Full repo install works; per-skill install works alone. |
| `relay-merge` | None | Nothing - standalone. | Full repo install works; per-skill install works alone. |
| `relay-sidecar` | None | Nothing - standalone. | Full repo install works; per-skill install works alone. |
