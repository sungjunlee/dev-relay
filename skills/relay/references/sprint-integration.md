# Sprint Integration

Sprint tracking is optional. When in use, resolve ownership through the
dev-backlog `sprint-state.js` contract below; `../SKILL.md` defers here for
sprint ownership resolution. The task's `track:` or `component:` value is the
sprint ownership handle.

## Ownership Resolution

(a) Before any sprint read, invoke the resolved dev-backlog `sprint-state.js --track <track> --json backlog` or `sprint-state.js --component <component> --json backlog` and use `active_sprint.path` as the owning sprint.

(b) With no handle, use `sprint-state.js --json backlog` only when exactly one sprint is active; if a selector lookup is unavailable or unresolved, allow that same fallback only when the single sprint's track/component matches.

(c) Never choose an arbitrary/global active sprint or parse sprint markdown in relay to resolve ownership.

(d) If no owner resolves, skip sprint tracking; otherwise re-read that sprint's Running Context, batch information, and completed/in-flight changes and apply previous-task context.

## In-Flight Writes

(e) Before an in-flight write, resolve the owner through the same dev-backlog `sprint-state.js --track/--component --json` contract and matching-selector N==1 failure fallback, then update only its `active_sprint.path`; skip when no owner resolves.
