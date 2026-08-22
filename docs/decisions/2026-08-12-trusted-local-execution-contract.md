# Trusted-local execution contract

**Status:** Accepted 2026-08-12 (`#1231`; `#1232`–`#1234`, `#1252` implemented).
**Supersedes:** the mandatory Relay-owned isolation and staged-credential
policy of `#1141` / `#1158`.

## Decision

1. **One trusted-local execution path.** No trusted/hardened switch and no
   second mode. Executions launch directly on the operator's trusted local
   host. Secrets are never serialized into facts or argv. Where a CLI supports
   native filesystem isolation, Relay requests it; where it does not, Relay
   still runs and reports the absence. This is not a hostile-worker boundary.
2. **Native capability is adapter-owned.** Filesystem isolation and
   tool-network control are separate. The live matrix lives in
   [agent-adapter-platform.md](../../skills/relay-dispatch/references/agent-adapter-platform.md),
   not in this record.
3. **Missing isolation is a diagnostic, never an admission failure.** No new
   fact kind and no durable diagnostic artifact. Tool networking defaults to
   `enabled`; an explicit `disabled` request fails closed for a phase without
   native deny. Dispatch has fixed writable-worktree semantics.
4. **Hostile multi-tenant execution is out of scope.** Multi-tenant or hostile
   remote workers need an external container or VM.
5. **Retained invariants stay.** Worktree-only dispatch; immutable `run.json`
   and append-only facts; inspect-before-write and same-action reinspection;
   staged review-input integrity; argv-only spawn; `inherited_scope_no_daemon`;
   exact-SHA independent review; explicit merge with no bypass.
6. **Cutover is settled.** Historical cleanup artifacts are inert. There is no
   compatibility reader or migration overlay. New recovery removes only the
   signed staged review-input root after exact process settlement.

## Evidence

Adapter descriptors in `skills/relay-dispatch/scripts/adapters/` and
[architecture.md](../architecture.md).
