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

Pi's ordinary catalog may include `alibaba-plan/*` through the ambient
`pi-alibaba-models` extension. Relay keeps `--no-extensions` enabled for review,
then binds the package manifest and its exact `extensions/alibaba.ts` entry into
the hosted runtime evidence before adding `--extension <canonical-entry>`. Missing, malformed, escaped, symlinked,
or replaced evidence fails closed before provider execution with a typed
extension-binding diagnostic.

## Primary Reviewer Contract

`review-runner.js` stages an immutable prompt, diff, and verdict schema, then
calls the same adapter's `buildInvocation({phase: "primary_review", ...})`
directly. The durable host invokes that argv without a legacy reviewer wrapper;
the adapter parses its staged output into the strict verdict contract.

A new run binds its reviewer in immutable `run.json`. An explicit review model
applies to that invocation; otherwise the adapter default is used. Historical
`model_hints` data is inert and never participates in selection.

| Reviewer | Invocation and filesystem capability |
| --- | --- |
| `codex` | Ephemeral native `read-only` review with schema output. |
| `claude` | Dispatch uses settings-based native Bash with no unsandboxed fallback; primary review uses `--safe-mode`, `Read` only, and explicitly marks native isolation `not_requested`. |
| `opencode` | Prompt-only review; no native filesystem sandbox. |
| `pi` | `read,grep,find,ls` tool allowlist; no native filesystem sandbox. |
| `antigravity` | `agy` CLI with its declared, unverified `--sandbox`. |
| `cursor` | Agent ask mode with native sandbox enabled. |

Cline remains a dispatch executor. It is not a primary reviewer because it has
no registered structured primary-review output contract.
All review timeouts use the closed `review-runner.js --timeout <seconds>` input;
there are no adapter-specific timeout environment variables.
Antigravity primary review remains experimental in its static adapter
descriptor; its actual CLI availability is reported only when an operator
invokes it, never as a repository release condition.
Antigravity transports its prompt as argv and rejects invocations at a
conservative 256 KiB argv budget before launch. Local process-list access can
therefore disclose prompt content while `agy` is running.

## Network and native filesystem capabilities

The trusted local CLI's remote provider control-plane transport is available.
`networkAccess` separately describes model/tool networking and must
be enforced by native adapter policy. Pi exposes a native constrained tool set;
Claude, Codex, Cursor, Antigravity, OpenCode, and Cline are informational
only because their installed CLI flags do not prove that every internal or
server-side or managed-policy tool is network-disabled. Tool networking
defaults to `enabled` for trusted-local dispatch; an explicit `disabled`
request requires a native deny and fails closed for a phase without one.

Relay owns no filesystem profile or platform admission. Codex requests its
native `workspace-write` dispatch or `read-only` review sandbox, Cursor enables
its native sandbox, Claude enables its documented Bash sandbox for dispatch
only and uses safe-mode Read-only primary review, and Antigravity retains its
declared flag. Pi, OpenCode, and Cline run directly. The foreground
and dry-run `filesystem_isolation` diagnostic reports the static
requested/effective capability; absence or declaration-only support is visible
but never an admission failure. These argv descriptors still require the host
supervisor for immutable staging, executable binding, timeout/cancellation, and
scope-safe cleanup.

## Prompt and ambient CLI sessions

Claude, OpenCode, Pi, Cursor, and Codex transport the exact prompt over stdin
(`codex` uses its stdin-dash form). Prompt bytes and their SHA-256 binding are
staged as immutable inputs. Cline and Antigravity are the only argv-visible
exceptions because their installed CLIs expose no safe stdin prompt contract;
both reject prompts at the conservative 256 KiB limit, and their prompt content
is visible to local process-list readers for the lifetime of the CLI.

Dispatch and review inherit the local user's ordinary CLI session, including
`HOME`, XDG configuration roots, provider authentication, and custom CA
configuration. Relay neither copies credential files nor creates a private
HOME/XDG tree. It removes only narrowly dangerous Relay and runtime-injection
environment keys before handing that ambient environment to the detached host;
the values themselves travel only through the host's unlinked secret-FD
payload and never into durable run artifacts. `--credential-env` and
`--credential-file` are retired unknown options. An unavailable ambient login
is a typed authentication failure that the operator fixes with that CLI's
normal login/setup flow.

Claude dispatch runs with `--settings` that enables its native Bash sandbox and
permits Bash while `allowUnsandboxedCommands:false` blocks automatic fallback.
Claude primary review instead uses `--safe-mode`, permits only `Read`, and
explicitly disallows `Bash`, `Write`, and `Edit`; its native-isolation
diagnostic is `not_requested`. Relay never extracts a provider login from the
macOS Keychain, and `--bare` is not used because it rejects subscription OAuth.

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

All commands are built as argv arrays. Adapters that cannot represent a requested
tool-network behavior fail closed; filesystem isolation absence instead emits the
foreground diagnostic. Contract tests use fake binaries; their purpose is
stable argv and lifecycle behavior, not live provider-health certification.

The Relay host and its lifecycle/review seams run on macOS and Linux. Native
filesystem controls remain adapter- and platform-specific: an unavailable
native control is visible in the diagnostic but never blocks an otherwise valid
trusted-local invocation.

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
- A filesystem policy cannot prevent a CLI from calling `setsid`, clearing its
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
