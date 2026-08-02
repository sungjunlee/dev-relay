Parent: #1129

## Outcome

Make executor diversity a stable platform capability while removing executor-specific lifecycle branching.

## Adapter contract

Each executor descriptor provides static metadata and exactly four methods:

1. `probe`
2. `capabilities`
3. `buildInvocation`
4. `parseOutcome`

Invocations are argv arrays only. Shell command strings are forbidden.

## Scope

- Migrate Codex, Claude, Cursor, OpenCode, Pi, Antigravity, and Cline.
- Share the same descriptor between dispatch and review where the executor supports both roles.
- Define capability negotiation and shared JSON/stdin/stdout protocols for future native adapters.
- Add transcript-based conformance fixtures.

## Acceptance criteria

- [ ] All seven currently supported executors remain available.
- [ ] Dispatch and review contain no branching on executor names.
- [ ] Every adapter passes the same probe, capability, invocation, outcome, quoting, timeout, and cancellation suite.
- [ ] No adapter or core path invokes a shell through an interpolated command string.
- [ ] Adding a future executor requires one descriptor file, fixtures, and registration only.
- [ ] Unsupported capabilities fail before worktree mutation with a precise error.
- [ ] Live canaries pass the exact 13-cell matrix (all seven dispatch phases and all six declared primary-review phases). Missing CLIs or explicit credentials are `not_run_*` and keep evidence non-release; skip and fallback never satisfy a cell. The 2026-08-02 evidence is honestly incomplete (2/13) until operators provision every phase. Both Codex cells pass the real production path. The remaining eleven are typed external blockers at current head:

  - `claude`, `opencode`, `pi` (6 cells) — `credential_source_rejected` / `UNTRUSTED_CREDENTIAL`. Their declared source files include group/world-readable config (`~/.claude/settings.json`, `~/.config/opencode/opencode.json{,c}`, `~/.pi/agent/settings.json`, `~/.pi/agent/models.json`). `host.js` requires every credential source to be a current-user owner-only regular file (`mode & 0o077 === 0`). Codex passes because both of its sources are already `0600`. Resolution is an operator decision to tighten those files; the canary must not launder the mode by staging a relaxed copy.
  - `antigravity:dispatch` — `invocation_timeout` at 90s; `antigravity:primary_review` — `credential_auth_failed`. Antigravity authentication is bound to the system keyring, which is deliberately outside the staged credential root.
  - `cursor` (2 cells) and `cline:dispatch` — `invocation_failed`. Both CLIs probe available and version-identified, so this is account/subscription or route state, not a missing binary.

## Verification

- Golden argv and transcript fixtures for all adapters.
- Metacharacter and path-with-spaces tests.
- Dispatch/review role matrix and cancellation tests.

## Out of scope

- Reducing the number of supported executors.
- Choosing a preferred executor.

## Dependencies

- #1130
