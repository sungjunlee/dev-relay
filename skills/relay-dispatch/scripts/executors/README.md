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
3. Add tests in `tests/relay-dispatch/scripts/executors.test.js`.

That's it. `dispatch.js` and `probe-executor-env.js` will pick up the new executor automatically via `getExecutor(name)`.

opencode is an experimental dispatch executor. Reviewer policy is defined in `relay-dispatch/references/reviewer-policy-opencode.md`. opencode does not provide native sandbox enforcement; warnings surface this fact at dispatch time.

antigravity targets the Google Antigravity `agy` CLI only. The relay adapter does not read Antigravity IDE/Desktop state, GUI sessions, plugin runtime, or PTY state. `agy --version` is recorded as CLI-version evidence separately from any desktop app version.
