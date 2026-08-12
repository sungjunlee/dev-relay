# Relay Operator Guide

Relay stores an immutable run record and folds append-only facts into one
derived action. The action returned by inspection is the authority; do not infer
state from a PR comment, retired run artifacts, or an executor transcript.

## Source Gate

Relay requires Git and never initializes it automatically. Classify the
checkout before fetching, contacting a forge, creating a worktree or run
directory, or starting an executor:

```bash
node skills/relay/scripts/run-preflight.js \
  --stage route --repo . --issue-number <N> --branch issue-<N> --json
```

With no configured remotes, the result selects `local-reviewed-result`; do not
fetch or invoke `gh`, and use local task text or the user description. A
supported GitHub source retains the existing PR/in-flight dedup scan and may
fetch the reported remote, use `gh`, and proceed only with explicit executor
and reviewer ambient CLI authentication plus network availability. Non-Git input returns
`SOURCE_NOT_GIT` with explicit `git init` or direct `delegate` remediation.
Unsupported forges return `SOURCE_UNSUPPORTED_REMOTE`; GitLab is not supported
and Relay never silently falls back to local delivery.

## Default Workflow

```text
source gate -> prepare Done Criteria -> dispatch -> inspect -> recover -> review
                                                                    |       |
                                      local Reviewed Result <- recover       +-> GitHub merge (explicit)
```

1. After the source gate, dispatch a new immutable run. New runs require a frozen rubric or Done
   Criteria source; the run directory is claimed by a non-recursive `mkdir`,
   which fails closed if that run id already exists.

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
   operation that may commit, publish the GitHub revision, create/reuse a PR,
   record verification, close a dead attempt, or close a local Reviewed Result.

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
   returns `merge` on GitHub or `recover` for local Reviewed Result closure.

5. On the GitHub route, merge only on explicit operator authority.

   ```bash
   node skills/relay-merge/scripts/gate-check.js --repo . --run-id <id> --json
   node skills/relay-merge/scripts/finalize-run.js \
     --repo . --run-id <id> --merge-method squash --json
   ```

`finalize-run` is only for the GitHub route. It requires the exact current PR
source SHA, a passing independent review, passed verification for the frozen
Done Criteria, and a fresh GitHub observation. Local Reviewed Result delivery
stops at canonical recovery closure; it has no PR or merge step.

## Close a run

Closing is not its own verb: use `relay-recover recover` — the only mutating
operation — with an explicit operator and reason.
Closing a local Reviewed Result appends a `run_closed` fact and is idempotent
only for the same intent; a GitHub run instead reaches the explicit merge
boundary and cannot be closed as a local result.

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

### Prompt and ambient authentication

Claude, Codex, OpenCode, Pi, and Cursor receive prompts over digest-bound stdin.
Cline and Antigravity are the two argv-visible exceptions: prompt text may be
visible in the local process list, and Relay rejects prompts at 256 KiB.

Provider authentication is ambient local CLI state: HOME, XDG configuration,
keychain-backed sessions, and supported token variables remain visible exactly
as in direct use. Relay neither copies auth files nor rewrites HOME/XDG.
`--credential-env` and `--credential-file` are retired unknown options. Review
still stages only its immutable prompt/diff/criteria/schema bundle and removes
that exact bound staging root during cleanup/recovery.

### Process containment: `inherited_scope_no_daemon`

Every supported executor and reviewer CLI runs under the cooperative
`inherited_scope_no_daemon` contract. The host injects a per-attempt random
`RELAY_PROCESS_SCOPE` marker; supported CLIs must preserve it in every process
they start and must not daemonize, `setsid` away, or clear it.

The direct trusted-local host does not prevent a CLI from calling `setsid` or
clearing its environment, so containment is enforced by verification rather
than by prevention. macOS reports process start time only to the second, which cannot
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

## Runtime size

The Relay runtime is the only writer and there is no migration overlay. The
installed package is the current filesystem below
`skills/relay-dispatch/scripts/`; there is no generated inventory to refresh.

Retired run artifacts are not readable and `relay-recover` exposes only
`inspect` and `recover`. A repository holding retired state does not migrate:
its historical runs stay unreadable, and new work starts as a Relay run.
