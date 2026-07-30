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

## Review Adapter Invocation Notes

`relay-review` normally invokes reviewers through `review-runner.js`; operators should not call `invoke-reviewer-<name>.js` directly except when debugging an adapter. Review model precedence is `--reviewer-model` -> `manifest.model_hints.review` -> reviewer default. Advisory model precedence follows the advisory CLI flags, manifest routing, and adapter defaults documented in `model-routing.md`.

Isolation details by built-in reviewer:

| Reviewer | Invocation and isolation notes |
| --- | --- |
| `codex` | `invoke-reviewer-codex.js` passes ephemeral read-only review settings and expects structured verdict JSON. |
| `claude` | `invoke-reviewer-claude.js` uses bare/no-session-persistence review mode; `ANTHROPIC_API_KEY` or an authenticated Claude CLI session may be required. |
| `opencode` | `RELAY_OPENCODE_REVIEW_TIMEOUT` sets the primary-review parent timeout as a positive duration such as `120s`, `10m`, or `1h`; the default is `1800s`. Uses prompt-only read-only review plus dirty-worktree checks. Primary and advisory review are route-policy gated. |
| `pi` | `RELAY_PI_BIN` can override the binary path; `RELAY_PI_REVIEW_TIMEOUT` sets the primary-review parent timeout. Review uses a read/grep/find/ls allowlist plus dirty-worktree checks. |
| `antigravity` | `RELAY_ANTIGRAVITY_BIN` can override the binary path; `RELAY_ANTIGRAVITY_REVIEW_TIMEOUT` sets the review/canary parent timeout as a positive duration such as `120s`, `10m`, or `1h`; the default is `1800s`. Relay targets the `agy` command-line interface only; GUI, IDE, Desktop, plugin runtime, and interactive PTY flows are not supported. |
| `cursor` | `RELAY_CURSOR_AGENT_BIN` can override the binary path; `RELAY_CURSOR_REVIEW_TIMEOUT` sets the primary-review parent timeout. Primary review uses ask mode and parses the wrapper `result` field. |
| `cline` | `RELAY_CLINE_BIN` can override the binary path; `RELAY_CLINE_REVIEW_TIMEOUT` sets the Cline reviewer-script parent timeout for direct invocations (default `1800s`; internal `--timeout` is env − 60s). In advisory lanes the review-runner exports the lane budget (`--advisory-timeout` or profile default) as `RELAY_CLINE_REVIEW_TIMEOUT`, superseding any inherited value so parent kill and internal timeout share one number. Advisory review invokes `cline --json -P <provider> --cwd <repo> ... '<short workspace-relative @file reference>'`: the complete prompt stays in a temporary file under `--cwd`, matching Cline CLI 3.0.47's workspace-bounded mention parser, and relay removes the file on every exit path. Relay then parses the final JSONL `run_result.text`. Primary review is not supported until a healthy strict-verdict live canary passes. |

Advisory review can be a multi-lane list selected by CLI or routing. Each lane records reviewer/model/profile/trigger/gating identity in `advisory_review` events; supported profiles include `blindspot` and `adversarial`. Standard non-gating lanes record artifacts and metrics only, while gating lanes can demote an applied pass when successful advisory output contains required findings. Late artifacts are classified as metrics after a passing primary decision or redispatch evidence after changes requested.

For `policy.review_assurance=hardened`, the runner fails fast unless the command or manifest routing supplies an advisory reviewer. Advisory failures or required findings block a passing primary verdict, and execution evidence must be strict. When `execution-evidence.json` includes `verification_runs[]`, hardened gates prefer executor-confirmed command-run records collected from the original sandboxed dispatch and bound to its resulting HEAD; relay must never re-run those commands with orchestrator privileges. Otherwise they fall back to legacy `test_exit_code=0` plus a SHA-bound result hash.

## Capability Matrix

| Adapter | Dispatch | Primary review | Advisory review | Sandbox | Read-only | Network | Structured output | Transport | App registration |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `codex` | Yes | Yes | No | Native Codex sandbox; dispatch supports `read-only` and `workspace-write`. | Native `read-only` for reviewer and read-only dispatch. | Dispatch can enable workspace-write network; review defaults disabled. | Dispatch result file; primary review JSON schema file. | `codex` CLI. | Yes, Codex App thread registration. |
| `claude` | Yes | Yes | No | Dispatch uses permission mode; primary review uses tool allowlist, not OS sandboxing. | Primary review via `--allowedTools=Read`. | Ambient/informational; dispatch `network-access=enabled` fails closed. | Dispatch stdout copied to result file; primary review JSON schema argv. | `claude` CLI. | Yes, Claude app session registration. |
| `opencode` | Yes, limited and route-specific | Yes, route-policy gated | Yes | Informational only; no native relay sandbox. Review uses prompt instructions plus status guards; advisory runs in a detached worktree. | Primary/advisory prompt plus git status guard; dispatch read-only is informational only. | Ambient/informational; no relay network gate. | Dispatch stdout copied to result file; primary verdict JSON text; advisory JSON text. | `opencode` CLI. | No. |
| `pi` | Yes | Yes | Yes | Dispatch has no native relay sandbox; review uses read/grep/find/ls tool allowlist plus status guard. | Primary/advisory via `--tools read,grep,find,ls` plus dirty-worktree check. | Dispatch ambient/informational; review has no network tool in the relay allowlist. | Dispatch stdout copied to result file; primary verdict JSON text; advisory JSON text. | `pi` CLI. | No. |
| `antigravity` | Yes, limited with route-specific healthy dispatch canary evidence for `google/antigravity-cli` | Yes, fail-safe experimental until healthy live reviewer canary passes | Yes, fail-safe experimental until healthy live advisory canary passes | `agy --sandbox`; dispatch also adds the git common dir with `--add-dir`. | Dispatch read-only is unsupported; review relies on prompt instruction plus dirty-worktree check. | Ambient/informational; `agy` exposes no relay network gate. | Dispatch stdout copied to result file; primary verdict JSON text; advisory JSON text. | `agy` CLI only. | No. |
| `cursor` | Yes, optional experimental | Yes, optional experimental | No | Dispatch uses `agent --sandbox enabled` when workspace-write is requested; relay passes `--workspace` only (never `agent --worktree`). | Primary review uses `agent --mode ask`; dispatch read-only is unsupported (fail-closed). | Ambient/informational; no relay network gate. | Dispatch stdout copied to result file; primary review parses JSON wrapper `result` field. | `agent` CLI. | Yes, `agent create-chat` when `--register` is used. |
| `cline` | Yes, explicit route-policy approval required | No, blocked until live strict-verdict canary promotion | Yes | Informational only; relay passes `--cwd` and never `cline --worktree`. | Advisory prompt plus detached-worktree status guard; dispatch read-only is informational only. | Ambient/informational; no relay network gate. | Dispatch and advisory review parse JSONL `run_result.text`. | `cline` CLI. | No. |

Antigravity support targets the Google Antigravity `agy` CLI only. Relay does not support Antigravity GUI, IDE, Desktop, plugin runtime, or interactive PTY state as a dispatch or review surface.

Cline support targets the Cline CLI only. Relay does not use Cline TUI, ACP, hub dashboard, GUI state, or `cline --worktree`. Use explicit `cline-pass/*` routes plus policy allow rules for dispatch or advisory review; primary review stays unsupported until a live canary proves `REVIEWER_VERDICT_JSON_SCHEMA` output in `run_result.text`, completion within `RELAY_CLINE_REVIEW_TIMEOUT`, and no worktree mutation. Timeouts, malformed JSONL, missing `run_result.text`, schema failures, and dirty worktrees are fail-safe limitations, not healthy evidence.

## Antigravity Live Support Status

Antigravity dispatch has route-specific healthy live canary evidence for `google/antigravity-cli` when the dispatch prompt binds work to the relay worktree. Antigravity primary and advisory review remain fail-safe experimental until healthy live reviewer canaries pass. Fake-bin tests alone do not prove live executor or reviewer success, and relay must keep that limitation visible in operator-facing status.

The healthy-path criteria are exact:

- Primary review: strict verdict JSON within timeout.
- Dispatch: minimal repository change to recoverable/reviewable state.
- Limitation path: documented CLI limitation, recorded as a limitation rather than success.

Use the operator canaries in `operator-utilities.md`, including `live-dogfood.js --dispatch-canary` for controlled healthy dispatch evidence. A `failed/escalated` result means relay failed safely or encountered a live CLI limitation; keep that role marked experimental or blocked. Healthy dispatch canaries pass only when they produce the minimal PR, and `ready_to_merge` is healthy only after the Antigravity primary reviewer returns strict verdict JSON inside the configured timeout. The Antigravity no-op/fail-safe dispatch canary is separate; a PR from that no-op path is failure, not healthy dispatch success. The fail-safe timeout canary is not healthy success; it verifies that a bounded timeout does not become a reviewable false positive.

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

# OpenCode dispatch, primary review, or advisory review with an explicit route
node skills/relay-dispatch/scripts/dispatch.js . --executor opencode --model example/opencode-model-fast -b issue-42 -p "..." --rubric-file rubric.yaml
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer opencode --reviewer-model example/opencode-model-fast --json
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer codex --advisory-reviewer opencode --advisory-reviewer-model example/opencode-model-fast --json

# Antigravity CLI dispatch and primary review
node skills/relay-dispatch/scripts/dispatch.js . --executor antigravity --model google/antigravity-cli -b issue-42 -p "..." --rubric-file rubric.yaml
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer antigravity --reviewer-model google/antigravity-cli --json
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer codex --advisory-reviewer antigravity --advisory-reviewer-model google/antigravity-cli --json

# Cursor Agent CLI dispatch and primary review (optional harness; add cursor to managed_cli for slug-only models)
node skills/relay-dispatch/scripts/dispatch.js . --executor cursor --model composer-2.5 -b issue-42 -p "..." --rubric-file rubric.yaml
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer cursor --reviewer-model composer-2.5 --json

# ClinePass dispatch and advisory review with an explicit route
node skills/relay-dispatch/scripts/dispatch.js . --executor cline --model cline-pass/glm-5.2 -b issue-42 -p "..." --rubric-file rubric.yaml
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --reviewer codex --advisory-reviewer cline --advisory-reviewer-model cline-pass/z-ai/glm-5.2 --json
```
