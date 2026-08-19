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
fetch or invoke `gh`. A supported GitHub source retains the existing PR scan
and may fetch. Non-Git input returns `SOURCE_NOT_GIT`. Unsupported forges
return `SOURCE_UNSUPPORTED_REMOTE`; GitLab is not supported.

## Default Workflow

```text
source gate -> prepare Done Criteria -> dispatch -> inspect -> recover -> review
                                                                    |       |
                                      local Reviewed Result <- recover       +-> GitHub merge (explicit)
```

1. After the source gate, dispatch a new immutable run. New runs require a frozen
   rubric or Done Criteria source; the run directory is claimed by a
   non-recursive `mkdir`.

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
   `--run-id`. A passing review returns `merge` on GitHub or `recover` for
   local Reviewed Result closure.

5. On the GitHub route, merge only on explicit operator authority.

   ```bash
   node skills/relay-merge/scripts/gate-check.js --repo . --run-id <id> --json
   node skills/relay-merge/scripts/finalize-run.js \
     --repo . --run-id <id> --merge-method squash --json
   ```

`finalize-run` is only for the GitHub route. Local Reviewed Result delivery
stops at canonical recovery closure; it has no PR or merge step.

## Close a run

Closing is not its own verb: use `relay-recover recover` with an explicit
operator and reason. A GitHub run reaches the explicit merge boundary and
cannot be closed as a local result.

## Skills

| Skill | Use |
| --- | --- |
| `/relay` | Plan, dispatch, review, and stop at the selected route boundary. |
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

Relay binds an executor and an optional model when a dispatch run is created.
Use `--executor` to select an adapter and `--model` for an explicit
provider/model value. Omitting `--model` delegates to that adapter's provider
default. On resume, the executor and model are immutable. A missing CLI fails
closed as `executable not found`. Unsupported reviewer/phase pairs fail closed
at review.

```bash
node skills/relay-dispatch/scripts/dispatch.js . \
  --branch issue-42 --prompt "Implement issue 42" \
  --executor opencode --model example/opencode-model-fast \
  --rubric-file /tmp/issue-42-rubric.yaml
node skills/relay-review/scripts/review-runner.js \
  --repo . --run-id <id> --reviewer pi --model example/pi-model-fast --json
node skills/relay-review/scripts/review-runner.js \
  --repo . --run-id <id> --reviewer antigravity --model google/antigravity-cli --json
```

## Operate from a clone

To operate relay from a checkout without installed skills, start with
`skills/relay/SKILL.md` in that checkout. Phase files are `skills/relay-ready/`,
`skills/relay-dispatch/`, `skills/relay-review/`, and `skills/relay-merge/`.
Do not rely on globally installed skills.

## Prompt and ambient authentication

Claude, Codex, OpenCode, Pi, and Cursor receive prompts over digest-bound stdin.
Cline and Antigravity are the two argv-visible exceptions: prompt text may be
visible in the local process list, and Relay rejects prompts at 256 KiB.

Provider authentication is ambient local CLI state. Relay neither copies auth
files nor rewrites HOME/XDG. `--credential-env` and `--credential-file` are
retired unknown options.

## Process containment

Every supported executor and reviewer CLI runs under the cooperative
`inherited_scope_no_daemon` contract. Survivors are reported, not killed.
Settle a `cleanup_incomplete` obligation with
`relay-recover recover --run-dir <dir> --reason "<why>"`. Details live in
`skills/relay-dispatch/references/agent-adapter-platform.md`.

## Runtime size

The Relay runtime is the only writer and there is no migration overlay. The
installed package is the current filesystem below
`skills/relay-dispatch/scripts/`. Retired run artifacts are not readable and
`relay-recover` exposes only `inspect` and `recover`.
