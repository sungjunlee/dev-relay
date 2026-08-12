# Agent Adapter Platform

Relay keeps executor and primary-review capabilities explicit. Every supported
harness can dispatch; only harnesses that can return the strict primary verdict
contract are registered as reviewers. Adapter capability is the only runtime
authorization surface.

## Adapter Contract

Every native adapter lives directly in `skills/relay-dispatch/scripts/adapters/`
and exposes the same four-method contract:

| Method | Purpose |
| --- | --- |
| `probe(...)` | Deterministic argv-only CLI availability and version preflight. |
| `capabilities(...)` | Fail-closed phase and containment negotiation. |
| `buildInvocation(...)` | Build an argv-only dispatch or review invocation. |
| `parseOutcome(...)` | Normalize text, JSON, or JSONL transcript output. |

`name`, `defaults`, and immutable `metadata` carry static facts such as the CLI
binary, timeout, output protocol, and provider default; metadata never contains
functions. Register a new adapter in `adapters/index.js`; executor/model
selection remains explicit at dispatch time.

`runtimeDependencies` is a narrow read declaration, not path discovery. Native
single binaries receive literal executable access only; Pi and Cline declare
their Node package roots, while Cursor declares only its version
directory. The host never infers and opens an executable's HOME parent.

## Primary Reviewer Contract

`review-runner.js` stages an immutable prompt, diff, and verdict schema, then
calls the same adapter's `buildInvocation({phase: "primary_review", ...})`
directly. The durable host invokes that argv without a legacy reviewer wrapper;
the adapter parses its staged output into the strict verdict contract.

A new run binds its reviewer in immutable `run.json`. An explicit review model
applies to that invocation; otherwise the adapter default is used. Historical
`model_hints` data is inert and never participates in selection.

| Reviewer | Invocation and isolation |
| --- | --- |
| `codex` | Ephemeral native read-only review with schema output. |
| `claude` | Safe/no-session-persistence mode with read-only tool access. |
| `opencode` | Prompt-only review inside the runtime's read-only OS boundary. |
| `pi` | `read,grep,find,ls` tool allowlist inside the runtime's read-only OS boundary. |
| `antigravity` | `agy` CLI only, inside the runtime's read-only OS boundary. |
| `cursor` | Agent ask mode; parses the wrapper `result` field. |

Cline remains a dispatch executor. It is not a primary reviewer because a
healthy strict-verdict live canary has not established that capability.
All review timeouts use the closed `review-runner.js --timeout <seconds>` input;
there are no adapter-specific timeout environment variables.
Antigravity primary review remains experimental until a healthy live reviewer
canary returns strict verdict JSON within timeout. Its dispatch canary must make
a minimal repository change to recoverable/reviewable state; a documented CLI limitation is not healthy success.
Antigravity transports its prompt as argv and rejects invocations at a
conservative 256 KiB argv budget before launch. Local process-list access can
therefore disclose prompt content while `agy` is running.

## Release canary acceptance

The test-only live runner requires an exact 13-cell matrix: dispatch for all
seven adapters plus primary review for every adapter that declares it (six at
present). Every cell must pass; a missing CLI, absent explicit credential,
diagnostic fallback, timeout, sandbox/authentication failure, or unexecuted cell
keeps the evidence `incomplete_non_release` and makes the command exit nonzero.

Each dispatch cell crosses `host.launchLocalSupervisor` and must create one
nonce-bound artifact without any other repository, Git, or outside mutation.
Each review cell crosses `runStore.invokeIndependentReviewer`, must return that
run's nonce through an exact JSON schema, and must leave the repository
unchanged. These are the production isolation entry boundaries; the runner does
not call `dispatch.js` because that would create lifecycle facts and publication
work unrelated to an adapter canary. Production CLI credential parsing has its
own contract tests, and the runner independently parses explicit
`adapter:phase` credential selectors.

Evidence records source-tree and dirty-state digests, runner/runtime hashes,
platform, executable identity/version, credential environment names and file
IDs, prompt/invocation/output digests, and boundary/cleanup/process audits. It
never records credential values or credential source paths, and the recorded
executable identity is the basename only — the old absolute-path evidence was
archived as superseded (2026-08-07, #1153) and the next canary run regenerates
current evidence under `docs/plans/relay-runtime-core-reset-vnext/`; it is
intentionally incomplete until operators provision every required cell.

The outer host boundary permits the trusted CLI's remote provider control-plane
transport. `networkAccess` separately describes model/tool networking and must
be enforced by native adapter policy. Pi exposes a native constrained tool set;
Claude, Codex, Cursor, Antigravity, OpenCode, and Cline are informational
only because their installed CLI flags do not prove that every internal or
server-side or managed-policy tool is network-disabled. A phase without a native deny fails
closed when tool networking is disabled. Enabling tool networking is an
explicit authorization, not a claim that sandbox-exec can distinguish provider
sockets from arbitrary child-process sockets.

The host/run-store `sandbox-exec` profile is also the authoritative filesystem
boundary. Codex runs its nested CLI sandbox as `danger-full-access`, and Cursor
runs its nested sandbox as `disabled`, because either nested sandbox rejects
paths already constrained by the outer profile. The requested Relay
`workspace-write` or `read-only` policy remains enforced by that outer profile.
These argv descriptors are unsafe to launch by themselves; dry-run exposes
them only as diagnostics and marks the required host boundary explicitly.

## Prompt and credential transport

Claude, OpenCode, Pi, Cursor, and Codex transport the exact prompt over stdin
(`codex` uses its stdin-dash form). Prompt bytes and their SHA-256 binding are
staged as immutable inputs. Cline and Antigravity are the only argv-visible
exceptions because their installed CLIs expose no safe stdin prompt contract;
both reject prompts at the conservative 256 KiB limit, and their prompt content
is visible to local process-list readers for the lifetime of the CLI.

Dispatch does not inherit ambient provider credentials. Operators must opt in
to each value with repeatable `--credential-env NAME` and to each declared
adapter file with `--credential-file ID=/absolute/source`. Valid file IDs come
from adapter metadata: Claude and Codex expose `auth` plus their settings/config
file, OpenCode exposes `auth`, `config_json`, and `config_jsonc`, Pi exposes
`auth`, `settings`, and `models`, Cursor exposes `cli_config`, Cline exposes
`providers`, and Antigravity exposes `oauth` plus `config`. Cursor may instead
use an explicitly selected `CURSOR_API_KEY`. Missing or structurally unsafe
session files remain typed `credentials_unavailable` evidence.
Sources are validated as exact private regular files and staged into an
attempt-private HOME/XDG root, then removed after the process tree terminates.

Claude runs both phases with `--safe-mode`: customizations are disabled while
authentication, model selection, built-in tools, and permissions remain
available. An unattended Claude Max canary requires the operator to generate a
long-lived token with `claude setup-token` and explicitly select
`CLAUDE_CODE_OAUTH_TOKEN` for both phase cells. Relay never extracts the macOS
Keychain login, and `--bare` is not used because it rejects subscription OAuth.

Credential flags are foreground-dispatch only. `--detach` with either flag
fails closed so credential source paths are never copied into detached process
argv. Primary review accepts the same repeated flags and catalog, but stages
selected values only inside its short-lived private HOME/XDG tree. Neither path
performs discovery or inherits an ambient HOME. A reviewer without the
explicitly requested credentials must stop as unavailable.

## Capability Matrix

| Adapter | Dispatch | Primary review |
| --- | --- | --- |
| `codex` | Yes | Yes |
| `claude` | Yes | Yes |
| `opencode` | Yes | Yes |
| `pi` | Yes | Yes |
| `antigravity` | Yes, experimental | Yes, experimental |
| `cursor` | Yes, experimental | Yes, experimental |
| `cline` | Yes | No |

All commands are built as argv arrays. Adapters that cannot represent requested
sandbox, read-only, or network behavior must fail closed or surface an explicit
capability warning. A fake-binary test is contract evidence, not proof that a
live provider integration is healthy.

Dispatch containment is independent of adapter-native flags. On macOS the host
wraps the actual executor process tree with `/usr/bin/sandbox-exec`, permitting
writes only to the retained worktree (for `workspace-write`), its exact result
artifact, an attempt-private temp directory selected through
`TMPDIR`/`TMP`/`TEMP`, plus the exact `/dev/null` endpoint needed for descendant
stdio. The `osascript` AppleEvent entry point, active checkouts, sibling worktrees,
home, broad temp, and arbitrary outside paths remain read-only. A platform without that enforceable
boundary fails with `EXECUTOR_WRITE_ISOLATION_UNAVAILABLE`; Relay does not claim
that a prompt or cwd check is isolation. All seven adapters remain registered
under the same host boundary.

### `inherited_scope_no_daemon`

Every adapter declares `processContainment: "inherited_scope_no_daemon"`, and the
host refuses any other value. This is a **cooperative CLI contract**, not a
sandbox guarantee:

- The host injects a per-attempt random `RELAY_PROCESS_SCOPE` marker into the
  executor environment. Supported CLIs **must preserve that marker in the
  environment of every process they start** and **must not daemonize, re-exec
  with a cleared environment, or otherwise drop it**.
- The random marker is the additional binding between a PID/PGID and the run.
  The required macOS command-line runtime exposes process start time at
  one-second resolution only, so identity alone cannot separate a same-second
  PID reuse. The host therefore revalidates the marker immediately before every
  signal and signals only individually verified PIDs, never a whole process
  group. This prevents natural PID reuse and mixed-PGID collateral kills; it is
  not unforgeable against a malicious same-UID process, which can inspect peer
  environments. Such a process is outside this cooperative adapter boundary.
- `sandbox-exec` **cannot prevent** a CLI from calling `setsid`, clearing its
  environment, or exec'ing a helper with a scrubbed environment. A CLI that does
  so is outside the contract: the host reports the survivors as
  `cleanup_incomplete` with their exact identities and fails closed instead of
  guessing which processes are safe to kill.
- Apple platform binaries redact their environment from the process table. An
  executor whose descendants are Apple-signed binaries is therefore not
  scope-verifiable and must be treated as contract-violating for containment.

Operators recover a fail-closed cleanup with `relay-recover recover`. If an exact
recorded identity is still live but its scope marker is no longer provable, Relay
returns `HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED` without signalling it. The
operator must independently verify and terminate that exact pid/pgid/start-time
identity, then rerun canonical recovery so Relay can sign settlement. Killing by
name or by a stale PID alone is outside the safety contract.

The linked-worktree administration directory, common object store, refs, config,
and hooks are deliberately outside the executor write set. Executors leave dirty
worktree content; canonical `relay-recover recover` exclusively owns commit,
remote-ref Publication, and the separate current-route Change Request handling.

## New Adapter Checklist

1. Add a four-method adapter in `scripts/adapters/` and register it in `adapters/index.js`.
2. Add `buildReview` and a `primary_review` capability only when strict verdict output is supported.
3. Add executor argv/probe tests and primary-review tests when applicable.
4. Keep missing-CLI probes deterministic: `{error, raw: null}`.
5. Document containment and adapter capability limitations.
6. Add concise operator examples.

## Examples

```bash
# Explicit executor and model
node skills/relay-dispatch/scripts/dispatch.js . \
  --executor pi --model openai/gpt-5 -b issue-42 -p "..."

# Explicit primary reviewer and model
node skills/relay-review/scripts/review-runner.js \
  --repo . --run-id "$RUN_ID" --reviewer pi \
  --model openai/gpt-5 --json

# Cline is dispatch-only
node skills/relay-dispatch/scripts/dispatch.js . \
  --executor cline --model cline-pass/glm-5.2 -b issue-42 -p "..."
```
