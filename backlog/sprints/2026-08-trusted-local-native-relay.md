---
milestone: Trusted-local native Relay
status: completed
started: 2026-08-12
due: TBD
component: "dispatch-execution"
---

# trusted-local-native-relay

## Goal
Relay uses the developer's ambient CLI authentication and configuration, requests lightweight native isolation when an adapter supports it, and remains usable without a native filesystem sandbox while preserving durable lifecycle, review, recovery, and explicit-merge guarantees.

## Plan
- [x] #1231 Define the trusted-local execution contract and native capability inventory [PR:#1237]
- [x] #1232 Atomically replace Relay sandbox-exec with native-when-available execution [PR:#1238]
- [x] #1233 Use ambient CLI auth/config and retire credential staging safely [PR:#1239]
- [x] #1234 Retired the 13-cell isolation release gate and obsolete provider-canary tests/docs
- [x] #1235 Dogfood ambient native Relay across all seven adapters and close the migration [PR:#1241]
- [x] #1230 Reconcile the epic and milestone after all five leaves close [completed by PR #1241 and post-merge GitHub reconciliation]

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
- 2026-08-13: Sprint closure is carried by PR #1241 after the 617/617 serialized gate and three independent LGTM reviews. Merging it closes #1235; the final external step reconciles epic #1230 and milestone 18 without adding another runtime or documentation PR.
- 2026-08-13: #1235 final local verification passed the full serialized gate 617/617 with zero failures/skips in 593.721 seconds, plus `git diff --check` and production syntax checks. The gate includes the current filesystem↔CI/reachability and zero-directive guards; generated ledger/runtime-inventory scripts were deleted by #1196 and were not reintroduced to satisfy stale issue wording. Real ambient dogfood reached canonical terminal Reviewed Result for Codex, Claude, Pi, and OpenCode; corrected Antigravity JSON dispatch completed a semantic task and exact verification, then its correctly bound native-schema review returned a typed reviewer escalation and remained unclosed; Cursor/Cline exposed provider/account blockers without sandbox or credential prerequisites. Existing PR #1226 and its retained run prove the normal GitHub exact-SHA/explicit-merge route. Independent Standards and Spec reviews found no implementation P1/P2; final post-gate review, PR checks, merge, and epic/milestone reconciliation remain.
- 2026-08-13: #1235 initial real dogfood invoked all seven retained adapters with ambient local state. Codex, Claude, Pi, and OpenCode completed bounded dispatch, canonical commit/verification, independent LGTM review, and terminal local Reviewed Result closure. Cursor reached its provider but both tested model selections were unavailable on the current plan; Cline reached its configured provider but returned a structured run error and its unsupported review contract failed before fact creation; Antigravity exposed an exit-zero/empty-output classification and an earlier text-mode review escalation. No case left a live host or pending cleanup. Dogfood then corrected non-Codex same-run executor resolution, macOS `/tmp` alias pre-write canonicalization, OpenCode's missing noninteractive diagnostic argv, and Antigravity's native JSON/schema contract. Permanent gate machinery was not reintroduced.
- 2026-08-13: #1233 implementation completed and independently reviewed LGTM on Spec, Standards/trust, and simplification axes. Relay now inherits sanitized ambient CLI HOME/XDG/auth without credential copying or public selectors; environment bytes cross only an already-unlinked FD/pipe, executor cleanup is process/scope-only, and reviewer cleanup retains the signed staged-input root. Final pre-merge legacy inventory remained 109 incomplete / 109 credential-root / 109 settled / 0 open / 0 parse errors. Authoritative focused gate passed 159/159 with zero skips; the full serialized gate passed 631 total (629 pass, 2 intentional live-canary skips, 0 fail). Diff: 32 files, +438/-1028.
- 2026-08-13: #1233 merged via PR #1239 after 10/10 GitHub Actions jobs passed; issue closed. #1234 then retired the permanent 13-cell provider release gate and its staged-home/credential canary tooling. Static fake-executable argv contracts and nonblocking native-isolation diagnostics remain; provider credentials and installed CLIs are no longer test prerequisites. Final gate and deletion measurements are recorded after the serialized rerun below.
- 2026-08-13: #1234 final verification passed the full serialized gate 611/611 with zero skips, `git diff --check`, direct filesystem↔CI/reachability checks, and the exact no-directive guard. The generated ledger/runtime-inventory layers were already deleted by #1196 and were not reintroduced; these direct checks are their current replacement. Runtime JavaScript remained 12,944→12,944 LOC, test/fixture JavaScript fell 19,930→19,116 LOC (−814), and the complete change is +124/−957 (net −833). Independent review found the retained immutable-review, timeout/cancel, process cleanup, crash convergence, exact-SHA review, and explicit-merge proofs intact.
- 2026-08-13: #1232 merged via PR #1238 after all 11 checks passed, including the new Ubuntu native-first production-seam job. Started #1233 on `issue/1233-ambient-cli-auth`; pre-cutover inventory found 109/109 cleanup-incomplete records canonically settled and zero open credential-root obligations.
- 2026-08-12: #1231 merged via PR #1237 after 9/9 CI; issue closed. Started #1232 on `issue/1232-native-first-host`; Luna(max) owns the bounded production/test implementation with cross-family review afterward.
- 2026-08-12: Started #1231 on `issue/1231-trusted-local-contract`; Qwen 3.8 Max owns the bounded contract/capability documentation implementation, followed by independent review before merge.
- 2026-08-12: Claude Opus 5 and Pi/Qwen independent reviews converged on the trusted-local native-first direction and identified atomic adapter/host replacement, review-input preservation, process cleanup, and existing cleanup obligations as required boundaries.
- 2026-08-12: Created milestone 18, epic #1230, ordered leaves #1231-#1235, and closed superseded #1141/#1158 with evidence-preserving comments.
- 2026-08-12: #1231 documentation drafted on `issue/1231-trusted-local-contract`: decision `docs/decisions/2026-08-12-trusted-local-execution-contract.md` plus a Decisions-index entry. Draft claimed an existing diagnostic surface and a final state; both were wrong (see next entry).
- 2026-08-12: #1231 draft revised in place after review, still docs-only and pre-merge: the ADR is accepted as the *target* contract only — the runtime stays under the old sandbox-exec/staged-credential contract until #1232-#1234 land; the capability table now separates CLI capability / current Relay request / target request / tool-network control / ambient auth / platform evidence with honest verification markings (Claude's native Bash sandbox is settings-based and separate from built-in file-tool permissions; codex and cursor native sandboxes are currently disabled by Relay; agy `--sandbox` is declared/unverified; pi/opencode/cline have none; all local live evidence is macOS); the missing-isolation diagnostic is now defined as `#1232` target behavior because adapter capability warnings are currently discarded, not surfaced; the `spec/capabilities.md` Decisions row was removed because that file describes implemented behavior; ADR reduced to ~80 lines per docs/decisions/README.md. Live inventory re-verified at 109/109 settled, zero open credential-root obligations. Independent review before merge still pending.
- 2026-08-12: #1231 final review passed: independent Standards and Spec axes plus Pi/Nous DeepSeek V4 Flash found no residual P1/P2 after corrections; skills-lint 34/34 and diff-check green. Ready for PR and merge.
- 2026-08-13: #1232 implementation is in focused verification: Relay-owned sandbox admission/profile launch is removed; native adapter capability diagnostics, direct cross-platform host seams, and zero-fact staged-review mutation handling are covered. Credential staging remains intentionally unchanged for #1233.
- 2026-08-13: Sprint closed. 6/6 tasks completed.
