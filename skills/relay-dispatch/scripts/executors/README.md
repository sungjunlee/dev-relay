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
2. Register it in `index.js`'s `EXECUTORS` map.
3. Add tests in `tests/relay-dispatch/scripts/executors.test.js`.

That's it. `dispatch.js` and `probe-executor-env.js` will pick up the new executor automatically via `getExecutor(name)`.

opencode is an experimental dispatch executor. Reviewer policy is defined in `docs/reviewer-policy-opencode.md`. opencode does not provide native sandbox enforcement; warnings surface this fact at dispatch time.
