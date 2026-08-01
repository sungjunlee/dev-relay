# Explicit Adapter and Model Selection

Relay binds an executor and an optional model when a dispatch run is created.
Use `--executor` to select one of the supported adapters and `--model` when an
adapter requires or benefits from an explicit provider/model value. Omitting
`--model` deliberately delegates to that adapter's provider default.

```bash
node skills/relay-dispatch/scripts/dispatch.js . \
  --branch issue-42 --prompt "Implement issue 42" \
  --executor opencode --model openai/gpt-5.6 \
  --rubric-file /tmp/issue-42-rubric.yaml
```

`relay-config check` is read-only: it reports whether a selected adapter and
model can serve the requested phase. It does not write project configuration,
presets, or selection state.

```bash
node skills/relay-config/scripts/relay-config.js \
  check dispatch opencode example/opencode-model-fast --json
node skills/relay-config/scripts/relay-config.js \
  check review pi example/pi-model-fast --json
node skills/relay-config/scripts/relay-config.js \
  check review antigravity google/antigravity-cli --json
```

On resume, the executor and model are immutable. A run with a null model
binding continues to use its adapter default; a legacy run without a model
binding rejects a newly supplied `--model` unless it is migrated through an
explicit audited operation. Persisted historical `model_hints`, `routes`, and
`routing` fields are inert audit data.
