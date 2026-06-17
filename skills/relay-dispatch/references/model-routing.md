# Model Routing

Dispatch model routing answers two separate questions:

- Which executor harness should run the task?
- Which provider/model route, if any, should that harness use?

Executor names such as `codex`, `claude`, `opencode`, `pi`, and `antigravity` select a CLI adapter. Provider/model route strings such as `example/opencode-model-fast`, `openai/gpt-5`, or `google/antigravity-cli` are the model-policy boundary.

## Dispatch Selection

For `dispatch.js`, executor selection starts with `--executor` and falls back to the existing relay default of `codex`.

Dispatch model selection uses this precedence:

```text
--model -> manifest model_hints.dispatch -> --model-hints dispatch=... -> executor model config
```

The selected model route still has to pass route policy before the executor runs. `model_hints` store preferences in the manifest; they do not approve a route by themselves.

## Managed And Unmanaged Executors

Codex and Claude are managed CLI defaults. They may intentionally run with `model: null`, because the authenticated managed CLI account is the operational boundary.

OpenCode, Pi, Antigravity, and other unmanaged harnesses should use explicit provider/model routes and matching route-policy allow rules. A missing or disallowed route fails before spawning the executor.

## Executor Model Config

Bundled executor model config intentionally ships empty so installs do not select a provider/model route on an operator's behalf. Operators can add local defaults without editing the skill by writing `~/.relay/executors.json`:

```json
{
  "executors": {
    "opencode": {
      "default_model": "example/opencode-model-fast",
      "candidate_models": ["example/opencode-model-fast"]
    }
  }
}
```

This file changes model selection only. It does not grant policy approval.

## Relay Skill Pass-Through

The top-level `relay` skill does not invoke `relay-dispatch` as a nested skill. It directly runs `skills/relay-dispatch/scripts/dispatch.js` during Step 3. To fix a route from `/relay`, pass dispatch options on that command:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . \
  --executor opencode --model example/opencode-model-fast \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml
```

For multi-phase hints:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . \
  --model-hints dispatch=example/opencode-model-fast,review=example/opencode-model-fast \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml
```
