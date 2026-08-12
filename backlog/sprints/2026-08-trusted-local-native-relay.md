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
- [x] #1231 Define the trusted-local execution contract and native capability inventory [PR:#1237]
- [~] #1232 Atomically replace Relay sandbox-exec with native-when-available execution [branch:issue/1232-native-first-host]
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
- 2026-08-12: #1231 merged via PR #1237 after 9/9 CI; issue closed. Started #1232 on `issue/1232-native-first-host`; Luna(max) owns the bounded production/test implementation with cross-family review afterward.
- 2026-08-12: Started #1231 on `issue/1231-trusted-local-contract`; Qwen 3.8 Max owns the bounded contract/capability documentation implementation, followed by independent review before merge.
- 2026-08-12: Claude Opus 5 and Pi/Qwen independent reviews converged on the trusted-local native-first direction and identified atomic adapter/host replacement, review-input preservation, process cleanup, and existing cleanup obligations as required boundaries.
- 2026-08-12: Created milestone 18, epic #1230, ordered leaves #1231-#1235, and closed superseded #1141/#1158 with evidence-preserving comments.
- 2026-08-12: #1231 documentation drafted on `issue/1231-trusted-local-contract`: decision `docs/decisions/2026-08-12-trusted-local-execution-contract.md` plus a Decisions-index entry. Draft claimed an existing diagnostic surface and a final state; both were wrong (see next entry).
- 2026-08-12: #1231 draft revised in place after review, still docs-only and pre-merge: the ADR is accepted as the *target* contract only — the runtime stays under the old sandbox-exec/staged-credential contract until #1232-#1234 land; the capability table now separates CLI capability / current Relay request / target request / tool-network control / ambient auth / platform evidence with honest verification markings (Claude's native Bash sandbox is settings-based and separate from built-in file-tool permissions; codex and cursor native sandboxes are currently disabled by Relay; agy `--sandbox` is declared/unverified; pi/opencode/cline have none; all local live evidence is macOS); the missing-isolation diagnostic is now defined as `#1232` target behavior because adapter capability warnings are currently discarded, not surfaced; the `spec/capabilities.md` Decisions row was removed because that file describes implemented behavior; ADR reduced to ~80 lines per docs/decisions/README.md. Live inventory re-verified at 109/109 settled, zero open credential-root obligations. Independent review before merge still pending.
- 2026-08-12: #1231 final review passed: independent Standards and Spec axes plus Pi/Nous DeepSeek V4 Flash found no residual P1/P2 after corrections; skills-lint 34/34 and diff-check green. Ready for PR and merge.
