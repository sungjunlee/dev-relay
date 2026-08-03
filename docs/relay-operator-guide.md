# Relay Operator Guide (vNext)

Relay vNext stores an immutable run record and folds append-only facts into one
derived action. The action returned by inspection is the authority; do not infer
state from a PR comment, a legacy manifest, or an executor transcript.

## Default Workflow

```text
prepare frozen Done Criteria -> dispatch -> inspect -> recover -> review -> merge
                                      ^                 |
                                      +--- redispatch ---+
```

1. Dispatch a new immutable run. New runs require a frozen rubric or Done
   Criteria source and an active sealed vNext generation.

   ```bash
   node skills/relay-dispatch/scripts/dispatch.js . \
     -b issue-42 --prompt-file /tmp/dispatch.md --rubric-file /tmp/rubric.yaml \
     --executor codex --detach --json
   ```

2. Inspect without mutation. Wait while the recommended action is `wait`.

   ```bash
   node skills/relay/scripts/relay-recover.js inspect --repo . --run-id <id> --json
   ```

3. When action is `recover`, use the returned action key. This is the sole
   operation that may commit, push, create/reuse a PR, record verification, or
   close a dead attempt.

   ```bash
   node skills/relay/scripts/relay-recover.js recover --repo . --run-id <id> \
     --reason "publish reviewed work" --expected-action-key <key> --json
   ```

4. When action is `review`, run the immutable bound primary reviewer.

   ```bash
   node skills/relay-review/scripts/review-runner.js \
     --repo . --run-id <id> --json
   ```

   A request for changes returns `redispatch`; dispatch again with the same
   `--run-id`, then follow inspection and recovery again. A passing review
   returns `merge`.

5. Merge only on explicit operator authority.

   ```bash
   node skills/relay-merge/scripts/gate-check.js --repo . --run-id <id> --json
   node skills/relay-merge/scripts/finalize-run.js \
     --repo . --run-id <id> --merge-method squash --json
   ```

`finalize-run` requires the exact current PR source SHA, a passing independent
review, passed verification for the frozen Done Criteria, and a fresh GitHub
observation. It has no review or state bypass.

## Close a run

Use the canonical recovery operation with an explicit operator and reason.
Closing appends a `run_closed` fact and is idempotent only for the same intent;
it cannot be applied to an already merged run.

## Skills

| Skill | Use |
| --- | --- |
| `/relay-config` | Read-only adapter capability check. |
| `/relay-dispatch` | Create or re-dispatch an immutable executor attempt. |
| `/relay-review` | Record the independent bound review. |
| `/relay-merge` | Explicit exact-SHA merge and cleanup. |
| `relay-recover.js` | Canonical inspect/recover/close surface. |

## Manual Phase Control

Use the individual commands in the Default Workflow when diagnosing or driving
one phase manually. Always re-run `inspect` after an external change and follow
the returned action key.

## Adapter Readiness Matrix

All seven built-in adapters support dispatch: Claude, Codex, OpenCode, Pi,
Antigravity, Cursor, and Cline. Claude, Codex, OpenCode, Pi, Antigravity, and
Cursor also support primary review. Cline is dispatch-only. The precise
capability matrix and four-method contract live in
`skills/relay-dispatch/references/agent-adapter-platform.md`.

## Executors

All seven executor descriptors remain supported: Claude, Codex, OpenCode, Pi,
Antigravity, Cursor, and Cline. Primary review currently supports all except
Cline. Check an adapter before dispatch:

```bash
node skills/relay-config/scripts/relay-config.js doctor --json
node skills/relay-config/scripts/relay-config.js \
  check --phase dispatch --executor opencode --model provider/model --json
```

The release-only adapter canary lives in the test suite; it is
intentionally not an installed operator command. See the [adapter platform](../skills/relay-dispatch/references/agent-adapter-platform.md).

Release evidence is all-or-nothing across 13 required cells (seven dispatch and
six declared primary-review cells). Run it only with explicit per-phase
credential selectors, for example
`--credential-env codex:dispatch:OPENAI_API_KEY`; repeat the selector for the
review phase and for every adapter. Missing credentials or CLIs are reported as
`not_run_*`, exit nonzero, and cannot be treated as a release pass. The runner
prints only credential environment names/file IDs and cryptographic digests,
never values or source paths.

### Prompt and credential limits

Claude, Codex, OpenCode, Pi, and Cursor receive prompts over digest-bound stdin.
Cline and Antigravity are the two argv-visible exceptions: prompt text may be
visible in the local process list, and Relay rejects prompts at 256 KiB.

Provider credentials are never selected implicitly. A foreground dispatch may
opt in an environment value with repeatable `--credential-env NAME` or a
declared adapter credential file with repeatable
`--credential-file ID=/absolute/source`, for example:

```bash
node skills/relay-dispatch/scripts/dispatch.js . \
  --executor codex --credential-env OPENAI_API_KEY \
  --credential-file auth=/absolute/path/to/auth.json \
  -b issue-42 --prompt-file /tmp/dispatch.md --rubric-file /tmp/rubric.yaml
```

Credential flags cannot be combined with `--detach`; this keeps source paths
out of detached argv. Primary review accepts the same repeatable flags and
adapter file IDs. It copies selected files into a private, short-lived HOME/XDG
tree and exposes only the named environment values; it never searches the
operator's HOME. A reviewer without explicit usable credentials stops as
credentials unavailable.

### Process containment: `inherited_scope_no_daemon`

Every supported executor and reviewer CLI runs under the cooperative
`inherited_scope_no_daemon` contract. The host injects a per-attempt random
`RELAY_PROCESS_SCOPE` marker; supported CLIs must preserve it in every process
they start and must not daemonize, `setsid` away, or clear it.

`sandbox-exec` cannot prevent a CLI from calling `setsid` or clearing its
environment, so containment is enforced by verification rather than by
prevention. macOS reports process start time only to the second, which cannot
separate a same-second PID reuse, so the host revalidates the scope marker
immediately before every signal and signals only verified individual PIDs—never
an entire process group. This protects against natural PID reuse and unrelated
members sharing a PGID, not a malicious same-UID process that can inspect peer
environments. That attacker is outside this cooperative contract. Unverifiable
survivors are reported, not killed:

- A dispatch ends `cleanup_incomplete` with a signed obligation listing the
  exact surviving identities; settle it with
  `relay-recover recover --run-dir <dir> --reason "<why>"`.
- A review fails with `independent reviewer cleanup incomplete`; inspect the
  reported `pgid` before terminating anything by hand.

A CLI that drops the marker is outside the contract and will produce these
fail-closed outcomes rather than silent, unbounded process leakage.

## Migration status

The production bootstrap is sealed to vNext. The migration overlay remains only
for legacy recovery translation and read observation. It retires after 30 days
and 30 vNext runs with zero legacy reads; until then the installed package is
18 JS / 8,262 LOC, with the post-retirement core target 16 JS / 6,049 LOC.
