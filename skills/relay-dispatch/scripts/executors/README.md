# Executors

Each file in this directory is an executor adapter. To add a new executor:

1. Drop a file here named `<executor>.js` exporting the 7-field contract:
   - `cliBinary` (string) — binary name on PATH used for `--version` preflight
   - `defaultTimeout` (number, seconds)
   - `validateExecutionMode({sandbox, networkAccess})` -> `{ok, error?, warnings?}`
   - `buildExecCommand({wtPath, resultFile, prompt, model, sandbox, networkAccess, reasoning})` -> `{cmd, args, cwd?, codexGitCommonDir?}`
   - `finalizeResult({stdoutLog, resultFile})` (optional, default no-op)
   - `register({wtPath, repoPath, branch, title, pin?})` -> `{threadId, raw}`
   - `probe({timeout})` -> `{error, raw}`
2. Register it in `agent-adapters/index.js` so dispatch, review, and policy metadata stay in one descriptor registry.
3. Add tests in `tests/relay-dispatch/scripts/executors.test.js`, `agent-adapter-policy.test.js`, reviewer tests when applicable, and docs consistency tests.

That's it. `dispatch.js` and `probe-executor-env.js` will pick up the new executor automatically via `getExecutor(name)`.

The full contract, capability matrix, and adapter checklist live in `skills/relay-dispatch/references/agent-adapter-platform.md`.

opencode is an experimental dispatch executor. Reviewer policy is defined in `relay-dispatch/references/reviewer-policy-opencode.md`. opencode does not provide native sandbox enforcement; warnings surface this fact at dispatch time.

antigravity targets the Google Antigravity `agy` CLI only. The relay adapter does not read Antigravity IDE/Desktop state, GUI sessions, plugin runtime, or PTY state. `agy --version` is recorded as CLI-version evidence separately from any desktop app version.

cursor targets the Cursor Agent `agent` CLI only. Dispatch uses `--workspace` and never `agent --worktree` so relay worktree isolation stays authoritative. Primary review uses `--mode ask --output-format json` and parses the wrapper `result` field into strict verdict JSON.

cline targets the Cline CLI only. Dispatch uses `--json --cwd <relay-worktree>` and never `cline --worktree` so relay worktree isolation stays authoritative. Relay parses the final JSONL `run_result.text` payload into the dispatch result file.
