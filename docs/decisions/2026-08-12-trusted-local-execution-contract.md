# Trusted-local execution contract

**Status:** Accepted 2026-08-12; `#1232`, `#1233`, `#1234`, and `#1252` implemented · Issue `#1231` · Epic `#1230` · Milestone "Trusted-local native Relay"
**Supersedes:** the mandatory Relay-owned isolation + staged-credential policy of `#1141` and the dispatch-availability policy derived from it in `#1158` ([Supersession](#supersession-of-1141-and-1158)).
**Runtime status:** `#1232` has removed Relay-owned `sandbox-exec` and its
non-darwin admission failure. Dispatch, review, observer, and recovery launch
directly on the trusted local host; adapter-native filesystem controls are
requested atomically and reported as non-durable diagnostics. `#1233` has
moved adapter authentication/configuration to ambient user HOME/XDG state and
removed credential staging.

## Context

The former runtime coupled every dispatch to a Relay-owned macOS
`sandbox-exec` filesystem boundary and to explicitly staged credentials.
Independent Claude Opus 5 and Pi/Qwen reviews of epic `#1230` converged on a
trusted-local, native-first path under four constraints: atomic host/adapter
replacement, preserved immutable review inputs and under-lock reinspection,
preserved process identity/cleanup/recovery, and settlement of existing
credential-root cleanup obligations before their reader is deleted. This record
freezes the contract and the native capability inventory used by `#1232`–`#1234`.

## Decision

### 1. One trusted-local execution path

One execution contract: no trusted/hardened switch, no second mode, no mode registry. Executions launch directly on the operator's trusted local host; secrets are never serialized into facts or argv. Where a CLI supports native filesystem isolation, Relay requests it; where it does not, Relay still runs and reports the absence. A direct process may read other files accessible to that local user, so this is not a hostile-worker boundary. `#1232` removed the mandatory outer sandbox; `#1233` moved authentication and configuration to ambient HOME/XDG state after its cleanup rule was satisfied.

### 2. Native capability inventory (seven adapters)

Filesystem isolation (OS/CLI enforcement of writable paths) and tool-network control (policy over the executor's own tool network access) are separate capabilities, never conflated. Rows are grounded in the adapter descriptors (`skills/relay-dispatch/scripts/adapters/<name>.js`) and in the local `--help`/version evidence footnoted below. Host launch is cross-platform after `#1232`; individual CLI enforcement evidence remains macOS-local or vendor-declared where marked.

| Adapter | FS isolation CLI capability | Current Relay request | Tool/network control | Ambient auth evidence | Platform evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | Native Bash sandbox via `sandbox.enabled` settings (Seatbelt on macOS, bubblewrap on Linux/WSL2); no CLI sandbox flag; built-in file tools remain permission-bound, not OS-sandboxed [^1] | Dispatch enables native Bash/Bash with `allowUnsandboxedCommands:false`; primary review is `--safe-mode`/`Read` only and explicitly `not_requested` | Native Bash network proxy plus tool permissions; direct file tools use permissions | Ambient user HOME/XDG CLI session; no Relay selector | macOS live; Linux/WSL2 vendor-declared, not locally exercised |
| `codex` | Native — `--sandbox read-only\|workspace-write\|danger-full-access` declared in help | `--sandbox workspace-write` dispatch; `read-only` review | Informational — no fail-closed tool-network switch | Ambient user HOME/XDG CLI session; no Relay selector | macOS live; Linux unverified |
| `opencode` | None — help declares no sandbox | None; diagnostic only | Informational | Ambient user HOME/XDG CLI session; no Relay selector | macOS live; Linux unverified |
| `pi` | None — help declares no sandbox | None; diagnostic only | Native constrained toolset — `--tools read,grep,find,ls[,write,edit]`, `--no-extensions --no-skills --no-session --no-context-files`; adapter `networkControl: "native"` | Ambient user HOME/XDG CLI session; no Relay selector | macOS live; Linux unverified |
| `antigravity` | Declaration-only — `--sandbox` ("terminal restrictions") declared in help; enforcement unverified by Relay | `--sandbox`; declaration-only diagnostic | Informational — no verifiable tool-network block | Ambient user HOME/XDG CLI session; no Relay selector | macOS live; Linux unverified |
| `cursor` | Native — `--sandbox enabled\|disabled` declared in help | `--sandbox enabled` dispatch and review | Informational | Ambient user HOME/XDG CLI session; no Relay selector | macOS live; Linux unverified |
| `cline` | None — help declares no sandbox | None; diagnostic only | Informational | Ambient user HOME/XDG CLI session; no Relay selector | macOS live; Linux unverified (dispatch-only; no primary review) |

[^1]: Local evidence, this host 2026-08-12. Versions: claude 2.1.228, codex 0.147.0, agent 2026.08.11-e8db854, agy 1.1.11, pi 0.84.1, opencode 1.18.16, cline 3.0.49. `claude --help` defines `--safe-mode` as customization disabling and exposes no sandbox flag; Anthropic's [sandboxing reference](https://code.claude.com/docs/en/sandboxing) documents the settings-based Bash sandbox, OS/platform enforcement, nonblocking unavailable fallback, and the separate permission boundary for built-in file tools.

### 3. Missing isolation: diagnostic, never blocking (`#1232` implemented behavior)

- Missing or declaration-only native filesystem isolation never fails admission; it must emit a visible, nonblocking diagnostic.
- Foreground and dry-run dispatch, and foreground review result objects, carry requested/effective filesystem-isolation diagnostics. No new fact kind, no schema change, no durable diagnostic artifact, no second mode.
- `#1252`: tool networking defaults to `enabled` for trusted-local dispatch, so routine new and resume dispatch carries no network ceremony. The fail-closed semantics now apply only to an explicit `networkAccess: disabled` advanced request: a phase without native network control rejects it before any branch, worktree, run, fact, or provider effect. The public `--sandbox` flag is retired; dispatch has fixed writable-worktree semantics while the adapter/phase owns its truthful native filesystem request.

### 4. Hostile multi-tenant execution is out of scope

Relay's threat model is a trusted single-user development host. Multi-tenant or hostile remote workers require an external container or VM; Relay grows no machinery for that threat model.

### 5. Retained invariants

Worktree-only dispatch; immutable `run.json` and append-only `events.jsonl` through `facts.appendFact`; inspect-before-write and re-inspect under the run lock with the same action key; staged review-input integrity (immutable, directly contained prompt/diff/criteria/schema paths with SHA-256 bindings); argv-only spawning, executable binding, timeout/cancellation, and process cleanup under `inherited_scope_no_daemon`; recovery through the single general writer (`recover.js` via `host.withRunLock`); exact-SHA independent review bound to frozen Done Criteria; explicit merge with no bypass. The bundle contains no executor transcript. A staged-input mutation, drift, or containment violation fails typed with zero review facts rather than becoming a retryable runtime escalation. None of these is relaxed by this contract.

### 6. Settled cutover

New `cleanup_incomplete` records carry process identities and, for review, an
exact `obligation.staged_input_root` (path plus dev/ino binding).

**Inventory (2026-08-12, this host):** 109 pre-cutover
`host-attempt-*.cleanup-incomplete.json` markers under `~/.relay/runs`, every
one matched by a `cleanup-settled.json` marker — zero open obligations at
acceptance time.

**Cutover:** the pre-cutover inventory is settled (109 markers, 109 settled,
zero open). Historical cleanup artifacts are inert history: no compatibility
reader or migration overlay remains. New recovery removes only
the signed staged review-input root after exact process settlement.

## Consequences

- `#1232` (implemented): atomically removes the outer `sandbox-exec` boundary; Codex/Cursor request their native sandboxes; adds the visible capability diagnostic of §3.
- `#1233` (implemented): moves all seven adapters to ambient HOME/auth/config and deletes credential staging after the §6 rule was satisfied.
- `#1234` (implemented): retires the provider-credential-dependent 13-cell release gate and its obsolete tests/docs. Static adapter argv contracts and the nonblocking native-isolation diagnostic remain; `#1235` dogfoods normal operator use without becoming a release gate.
- `#1252` (implemented): defaults trusted-local dispatch/redispatch tool networking to `enabled`, retires the public dispatch `--sandbox` flag and its fleet leaf/schema/argv forwarding, and freezes dispatch to writable-worktree semantics with adapter-owned native filesystem requests. Explicit `enabled` is byte-equivalent; explicit `disabled` remains the advanced native-deny request.

## Supersession of #1141 and #1158

`#1141`'s mandatory staged-credential/Relay-owned isolation policy and `#1158`'s availability framing are superseded; both issues were closed with superseding comments on 2026-08-12. Their live evidence remains archived only: canary failures (`docs/archive/plans/relay-runtime-core-reset-vnext/adapter-live-canary-2026-08-01.json` … `-03.json`) and `#1158`'s per-executor mechanism table (Keychain-bound cursor auth, cline cookie store, incomplete agy OAuth). They explain the move to ambient HOME in §1 and do not form a current release condition.

## Evidence

- Sprint convergence: `backlog/sprints/2026-08-trusted-local-native-relay.md`; epic `#1230` ordering.
- Adapter descriptors `skills/relay-dispatch/scripts/adapters/*.js`; capability prose `skills/relay-dispatch/references/agent-adapter-platform.md`.
- Warning-discard proof: `adapter-contract.js` `capabilities()` attaches `warnings`; `dispatch.js` has no consumer.
- Settlement: `docs/relay-operator-guide.md` ("survivors are reported, not killed"); `host.js` `paths.cleanup`/`paths.settled`, `obligation.staged_input_root`; inventory counted 2026-08-12 (109/109 settled).
