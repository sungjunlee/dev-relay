---
milestone: Trusted-local native Relay
status: active
started: 2026-08-12
due: TBD
component: "dispatch-execution"
---

# trusted-local-native-relay

## Goal
Relay uses the developer's ambient CLI authentication and configuration, requests lightweight native isolation when an adapter supports it, and remains usable without a native filesystem sandbox while preserving durable lifecycle, review, recovery, and explicit-merge guarantees.

## Plan
- [~] #1231 Define the trusted-local execution contract and native capability inventory [branch:issue/1231-trusted-local-contract]
- [ ] #1232 Atomically replace Relay sandbox-exec with native-when-available execution
- [ ] #1233 Use ambient CLI auth/config and retire credential staging safely
- [ ] #1234 Retire the 13-cell isolation release gate and subtract obsolete tests/docs
- [ ] #1235 Dogfood ambient native Relay across all seven adapters and close the migration
- [ ] #1230 Reconcile the epic and milestone after all five leaves close

## Running Context
- One trusted-local path; no trusted/hardened mode switch.
- Retain all seven adapters. Codex, Claude, Pi, and OpenCode are current priority development paths, but the other three are not retired.
- Ambient HOME/auth/config replaces copied credentials and private HOME/XDG roots.
- Native filesystem isolation is requested when supported and reported when absent; absence is never an admission failure. Pi tool-network policy is a separate capability.
- The outer host sandbox removal and adapter native-flag changes land atomically.
- Keep worktrees, immutable run/facts, staged review-input integrity, argv-only execution, executable binding, timeout/cancel/process cleanup, recovery, exact-SHA independent review, and explicit merge.
- Existing cleanup-incomplete records with credential-root obligations must be settled by canonical recovery before their reader is deleted. No migration overlay.
- Multi-tenant or hostile remote workers remain outside Relay and require an external container or VM.
- #1141 and #1158 are superseded by #1230; their live failure evidence remains historical input.

## Progress
- 2026-08-12: Started #1231 on `issue/1231-trusted-local-contract`; Qwen 3.8 Max owns the bounded contract/capability documentation implementation, followed by independent review before merge.
- 2026-08-12: Claude Opus 5 and Pi/Qwen independent reviews converged on the trusted-local native-first direction and identified atomic adapter/host replacement, review-input preservation, process cleanup, and existing cleanup obligations as required boundaries.
- 2026-08-12: Created milestone 18, epic #1230, ordered leaves #1231-#1235, and closed superseded #1141/#1158 with evidence-preserving comments.
