# Agent Adapter Platform

Relay has one adapter registry for agent harnesses. A harness can support dispatch, primary review, advisory review, or any combination of those phases. Provider/model route policy is separate from adapter capability: the adapter decides whether a phase and containment shape can be represented; route policy decides whether the selected provider/model route is allowed.

## Executor Contract

Every executor file in `skills/relay-dispatch/scripts/executors/<name>.js` exports the same 7-field contract:

| Field | Purpose |
| --- | --- |
| `cliBinary` | Binary name used for availability and version preflight. |
| `defaultTimeout` | Default dispatch timeout in seconds. |
| `validateExecutionMode({sandbox, networkAccess})` | Fail closed or warn before dispatch when the requested containment is not representable. |
| `buildExecCommand({wtPath, resultFile, prompt, model, sandbox, networkAccess, reasoning, timeoutSeconds})` | Build the non-interactive CLI command. |
| `finalizeResult({stdoutLog, resultFile})` | Optional result finalization; most stdout CLIs copy stdout into the relay result file. |
| `register({wtPath, repoPath, branch, title, pin?})` | Optional app/thread registration hook; unsupported adapters return `{threadId: null, raw}`. |
| `probe({timeout})` | CLI/environment probe used by `probe-executor-env.js`; missing CLIs return `{error: "<name> CLI not found", raw: null}`. |

Register the harness descriptor in `skills/relay-dispatch/scripts/agent-adapters/index.js`; update the compatibility order in `skills/relay-dispatch/scripts/executors/index.js` only when stable display order matters.

Reviewer adapters use `skills/relay-review/scripts/invoke-reviewer-<name>.js`. Primary reviewers return stdout JSON matching `REVIEWER_VERDICT_JSON_SCHEMA`; advisory reviewers return advisory JSON and never replace the primary verdict. All reviewer adapters are invoked as:

```bash
node invoke-reviewer-<name>.js --repo <repoPath> --prompt-file <promptPath> --json [--phase <primary_review|advisory_review>] [--model <route>]
```

## Capability Matrix

| Adapter | Dispatch | Primary review | Advisory review | Sandbox | Read-only | Network | Structured output | Transport | App registration |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `codex` | Yes | Yes | No | Native Codex sandbox; dispatch supports `read-only` and `workspace-write`. | Native `read-only` for reviewer and read-only dispatch. | Dispatch can enable workspace-write network; review defaults disabled. | Dispatch result file; primary review JSON schema file. | `codex` CLI. | Yes, Codex App thread registration. |
| `claude` | Yes | Yes | No | Dispatch uses permission mode; primary review uses tool allowlist, not OS sandboxing. | Primary review via `--allowedTools=Read`. | Ambient/informational; dispatch `network-access=enabled` fails closed. | Dispatch stdout copied to result file; primary review JSON schema argv. | `claude` CLI. | Yes, Claude app session registration. |
| `opencode` | Yes, experimental | Yes, route-policy gated | Yes | Informational only; no native relay sandbox. Review uses prompt instructions plus status guards; advisory runs in a detached worktree. | Primary/advisory prompt plus git status guard; dispatch read-only is informational only. | Ambient/informational; no relay network gate. | Dispatch stdout copied to result file; primary verdict JSON text; advisory JSON text. | `opencode` CLI. | No. |
| `pi` | Yes | Yes | Yes | Dispatch has no native relay sandbox; review uses read/grep/find/ls tool allowlist plus status guard. | Primary/advisory via `--tools read,grep,find,ls` plus dirty-worktree check. | Dispatch ambient/informational; review has no network tool in the relay allowlist. | Dispatch stdout copied to result file; primary verdict JSON text; advisory JSON text. | `pi` CLI. | No. |
| `antigravity` | Yes, fail-safe experimental until healthy live canary passes | Yes, fail-safe experimental until healthy live canary passes | Yes, fail-safe experimental until healthy live canary passes | `agy --sandbox`; dispatch also adds the git common dir with `--add-dir`. | Dispatch read-only is unsupported; review relies on prompt instruction plus dirty-worktree check. | Ambient/informational; `agy` exposes no relay network gate. | Dispatch stdout copied to result file; primary verdict JSON text; advisory JSON text. | `agy` CLI only. | No. |

Antigravity support targets the Google Antigravity `agy` CLI only. Relay does not support Antigravity GUI, IDE, Desktop, plugin runtime, or interactive PTY state as a dispatch or review surface.

## Antigravity Live Support Status

Antigravity live support is fail-safe experimental until a healthy live canary passes. Fake-bin tests alone do not prove live executor or reviewer success, and relay must keep that limitation visible in operator-facing status.

The healthy-path criteria are exact:

- Primary review: strict verdict JSON within timeout.
- Dispatch: minimal repository change to recoverable/reviewable state.
- Limitation path: documented CLI limitation, recorded as a limitation rather than success.

Use the operator canaries in `docs/relay-operator-guide.md#antigravity-live-canary`. A `failed/escalated` result means relay failed safely or encountered a live CLI limitation; keep the adapter marked experimental. `ready_to_merge` is healthy only when the dispatch canary produced the minimal PR and the Antigravity primary reviewer returned strict verdict JSON inside the configured timeout.

## New Adapter Checklist

1. Add the executor file exporting the 7-field contract above.
2. Add or update the descriptor in `agent-adapters/index.js`: phases, sandbox/read-only/network policy, structured output, transport, app registration, and model defaults.
3. Add reviewer scripts only for phases the descriptor marks supported. Shared primary/advisory scripts must parse the phase explicitly: primary review returns verdict JSON and advisory review returns advisory JSON.
4. Add tests under `tests/`, not under `skills/`: executor contract/argv/probe behavior, adapter policy audit, reviewer invocation or fail-closed behavior, and docs consistency when a supported adapter is added.
5. Probe behavior must be deterministic: missing CLI returns `{error, raw: null}`; available CLI records version/help/capability evidence without depending on GUI or desktop state.
6. Document route-policy expectations. Managed Codex/Claude may have `model: null`; unmanaged harnesses should pass explicit provider/model routes and policy allow rules.
7. Add concise usage examples to the dispatch and review skills when the adapter is operator-facing.

## Examples

```bash
# Pi dispatch and primary review
node skills/relay-dispatch/scripts/dispatch.js . --executor pi --model openai/gpt-5 -b issue-42 -p "..." --rubric-file rubric.yaml
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer pi --reviewer-model openai/gpt-5 --json
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer codex --advisory-reviewer pi --advisory-reviewer-model openai/gpt-5 --json

# OpenCode primary or advisory review
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer opencode --reviewer-model opencode-go/deepseek-v4-pro --json
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer codex --advisory-reviewer opencode --advisory-reviewer-model opencode-go/deepseek-v4-pro --json

# Antigravity CLI dispatch and primary review
node skills/relay-dispatch/scripts/dispatch.js . --executor antigravity --model google/antigravity-cli -b issue-42 -p "..." --rubric-file rubric.yaml
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer antigravity --reviewer-model google/antigravity-cli --json
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer codex --advisory-reviewer antigravity --advisory-reviewer-model google/antigravity-cli --json
```
