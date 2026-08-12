# Trusted-local execution contract

**Status:** Accepted 2026-08-12 as the *target* contract · Issue `#1231` · Epic `#1230` · Milestone "Trusted-local native Relay"
**Supersedes:** the mandatory Relay-owned isolation + staged-credential policy of `#1141` and the dispatch-availability policy derived from it in `#1158` ([Supersession](#supersession-of-1141-and-1158)).
**Runtime status:** This record changes no code. Until `#1232`–`#1234` land, every dispatch still runs under the old contract: the outer macOS `sandbox-exec` boundary, staged credentials in private HOME/XDG roots, the 13-cell release gate, and fail-closed `EXECUTOR_WRITE_ISOLATION_UNAVAILABLE` on non-darwin hosts.

## Context

The current runtime couples every dispatch to a Relay-owned macOS `sandbox-exec` filesystem boundary and to explicitly staged credentials. Independent Claude Opus 5 and Pi/Qwen reviews of epic `#1230` converged on replacing that with a trusted-local, native-first path under four constraints: atomic host/adapter replacement, preserved immutable review inputs and under-lock reinspection, preserved process identity/cleanup/recovery, and settlement of existing credential-root cleanup obligations before their reader is deleted. This record freezes the target contract and the exact native capability inventory so `#1232`–`#1235` can quote exact retained/deleted boundaries. Documentation only.

## Decision

### 1. One trusted-local execution path

One execution contract: no trusted/hardened switch, no second mode, no mode registry. Executions run with the operator's ambient HOME, authentication, and CLI configuration; secrets are never serialized into facts or argv. Where a CLI supports native filesystem isolation, Relay requests it; where it does not, Relay still runs and reports the absence. Relay stops owning the mandatory outer sandbox and credential staging (deleted in `#1232`/`#1233`, gates subtracted in `#1234`).

### 2. Native capability inventory (seven adapters)

Filesystem isolation (OS/CLI enforcement of writable paths) and tool-network control (policy over the executor's own tool network access) are separate capabilities, never conflated. Rows are grounded in the adapter descriptors (`skills/relay-dispatch/scripts/adapters/<name>.js`) and in the local `--help`/version evidence footnoted below. All live evidence is macOS (this host); Linux is target/unverified per adapter — no local source proves it for any adapter, and Linux dispatch is currently unreachable (`EXECUTOR_WRITE_ISOLATION_UNAVAILABLE`) until `#1232`.

| Adapter | FS isolation CLI capability | Relay requests today | Target request (`#1232`) | Tool/network control | Ambient auth evidence | Platform evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | Native Bash sandbox via `sandbox.enabled` settings (Seatbelt on macOS, bubblewrap on Linux/WSL2); no CLI sandbox flag; built-in file tools remain permission-bound, not OS-sandboxed [^1] | `--safe-mode` plus no-Bash tool allowlist, so the native Bash sandbox is unused; this is tool policy, not FS isolation | Enable settings-based sandbox, permit Bash for development, and keep its documented unsandboxed fallback nonblocking | Native Bash network proxy plus tool permissions; direct file tools use permissions | Ambient `~/.claude` OAuth/settings or supported token env; never extract Keychain | macOS live; Linux/WSL2 vendor-declared, not locally exercised |
| `codex` | Native — `--sandbox read-only\|workspace-write\|danger-full-access` declared in help; enforcement beyond Relay's current full-access usage unverified | `--sandbox danger-full-access` — the nested sandbox is disabled because the outer profile will not nest | `--sandbox workspace-write` (`read-only` for read-only phases) | Informational — no fail-closed tool-network switch | `~/.codex/auth.json`, `~/.codex/config.toml`, or `OPENAI_API_KEY` | macOS live; Linux unverified |
| `opencode` | None — help declares no sandbox | None | Same | Informational | `~/.local/share/opencode/auth.json`, `~/.config/opencode/opencode.json[c]` | macOS live; Linux unverified |
| `pi` | None — help declares no sandbox | None | Same | Native constrained toolset — `--tools read,grep,find,ls[,write,edit]`, `--no-extensions --no-skills --no-session --no-context-files`; adapter `networkControl: "native"` | `~/.pi/agent/{auth,settings,models}.json`; optional QWEN token env keys | macOS live; Linux unverified |
| `antigravity` | Declaration-only — `--sandbox` ("terminal restrictions") declared in help; enforcement unverified by Relay | `--sandbox` (workspace-write semantics) | Same — remains unverified; weakness is diagnostic, never blocking | Informational — no verifiable tool-network block | `~/.gemini/oauth_creds.json` + `config/config.json`; completeness unverified — a staged pair may still start fresh interactive OAuth (`#1158`) | macOS live; Linux unverified |
| `cursor` | Native — `--sandbox enabled\|disabled` declared in help | `--sandbox disabled` — the outer host boundary enforces instead | `--sandbox enabled` | Informational | `~/.cursor/cli-config.json`, or `CURSOR_API_KEY`; macOS Keychain holds login state a staged private HOME cannot read (`#1158`) | macOS live; Linux unverified |
| `cline` | None — help declares no sandbox | None | Same | Informational | `~/.cline/data/settings/providers.json`; its cookie-auth store is not covered by declarable files (`#1158`) | macOS live; Linux unverified (dispatch-only; no primary review) |

[^1]: Local evidence, this host 2026-08-12. Versions: claude 2.1.228, codex 0.147.0, agent 2026.08.11-e8db854, agy 1.1.11, pi 0.84.1, opencode 1.18.16, cline 3.0.49. `claude --help` defines `--safe-mode` as customization disabling and exposes no sandbox flag; Anthropic's [sandboxing reference](https://code.claude.com/docs/en/sandboxing) documents the settings-based Bash sandbox, OS/platform enforcement, nonblocking unavailable fallback, and the separate permission boundary for built-in file tools.

### 3. Missing isolation: diagnostic, never blocking (`#1232` target behavior)

- Missing or declaration-only native filesystem isolation never fails admission; it must emit a visible, nonblocking diagnostic.
- **Today no such surface exists.** Adapter `validateDispatch` warnings are computed by `capabilities()` but no consumer in `dispatch.js` prints or returns them — they are currently discarded.
- `#1232` target: foreground and dry-run dispatch result objects (the existing JSON output shapes) carry the capability diagnostic visibly. No new fact kind, no schema change, no durable diagnostic artifact, no second mode.
- Unchanged: the fail-closed tool-network semantics — a phase without native network control rejects `networkAccess: disabled` requests, and enabling tool networking remains an explicit authorization.

### 4. Hostile multi-tenant execution is out of scope

Relay's threat model is a trusted single-user development host. Multi-tenant or hostile remote workers require an external container or VM; Relay grows no machinery for that threat model.

### 5. Retained invariants

Worktree-only dispatch; immutable `run.json` and append-only `events.jsonl` through `facts.appendFact`; inspect-before-write and re-inspect under the run lock with the same action key; staged review-input integrity (immutable prompt/diff/verdict with SHA-256 bindings); argv-only spawning, executable binding, timeout/cancellation, and process cleanup under `inherited_scope_no_daemon`; recovery through the single general writer (`recover.js` via `host.withRunLock`); exact-SHA independent review bound to frozen Done Criteria; explicit merge with no bypass. None of these is relaxed by this contract.

### 6. Settle before cutover

`cleanup_incomplete` records carry `obligation.credential_root` (path plus dev/ino binding) alongside any surviving process identities.

**Inventory (2026-08-12, this host):** 109 `host-attempt-*.cleanup-incomplete.json` markers under `~/.relay/runs`, all carrying `credential_root` obligations and every one matched by a `cleanup-settled.json` marker — zero open credential-root obligations at acceptance time.

**Rule:** before `#1233` deletes the staging reader, every `cleanup_incomplete` record carrying a credential-root obligation must be settled through canonical `relay-recover recover --run-dir <dir> --reason "<why>"` (`HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED` means externally terminating the exact recorded identities and rerunning recovery). The matching `cleanup-settled.json` marker is the evidence. No compatibility reader, no migration overlay; records discovered after cutover are inert history.

## Consequences

- `#1232`: atomically removes the outer `sandbox-exec` boundary; codex/cursor stop disabling their native sandboxes; adds the visible capability diagnostic of §3.
- `#1233`: moves all seven adapters to ambient HOME/auth/config and deletes credential staging after the §6 rule is satisfied.
- `#1234`: retires the 13-cell gate and subtracts obsolete tests/docs; `#1235` dogfoods all seven adapters and closes the migration. Staging metadata (`credentialTransport`, staged-file catalogs) becomes inert as staging is deleted.

## Supersession of #1141 and #1158

`#1141`'s mandatory staged-credential/Relay-owned isolation policy and `#1158`'s availability framing are superseded; both issues were closed with superseding comments on 2026-08-12. Their live evidence remains linked: canary failures (`docs/archive/plans/relay-runtime-core-reset-vnext/adapter-live-canary-2026-08-01.json` … `-03.json`), and `#1158`'s per-executor mechanism table (Keychain-bound cursor auth, cline cookie store, incomplete agy OAuth), which motivates ambient HOME in §1 and the unverified markings in §2. The retired 13-cell matrix remains described in `skills/relay-dispatch/references/agent-adapter-platform.md` until `#1234`.

## Evidence

- Sprint convergence: `backlog/sprints/2026-08-trusted-local-native-relay.md`; epic `#1230` ordering.
- Adapter descriptors `skills/relay-dispatch/scripts/adapters/*.js`; capability prose `skills/relay-dispatch/references/agent-adapter-platform.md`.
- Warning-discard proof: `adapter-contract.js` `capabilities()` attaches `warnings`; `dispatch.js` has no consumer.
- Settlement: `docs/relay-operator-guide.md` ("survivors are reported, not killed"); `host.js` `paths.cleanup`/`paths.settled`, `obligation.credential_root`; inventory counted 2026-08-12 (109/109 settled).
