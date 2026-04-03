# Relay Scenario Tests

Initial scenario matrix for the manifest foundation wave.

## Goal

Exercise the parts that are already implemented, and separate them from behavior that is still planned.

## Current Coverage

### 1. Dispatch dry-run emits run metadata

Command:

```bash
node skills/relay-dispatch/scripts/dispatch.js . -b issue-42 --prompt "test prompt" --dry-run --json
```

Expect:

- `runId`
- `manifestPath`
- `cleanupPolicy`

### 2. Dispatch success writes manifest and ends in `review_pending`

Command:

```bash
python3 skills/relay-dispatch/scripts/smoke_dispatch_scenarios.py
```

Scenario:

- create a temp git repo
- dispatch a worker that creates `smoke.txt` and commits it

Expect:

- command exit code `0`
- `runState: review_pending`
- manifest contains `state: 'review_pending'`
- manifest contains `cleanup: 'on_close'`
- target repo contains `.relay/runs/`
- dispatched worktree still exists after the command returns
- harness explicitly removes the retained worktree during teardown

### 3. Dispatch no-op failure writes manifest and ends in `escalated`

Command:

```bash
python3 skills/relay-dispatch/scripts/smoke_dispatch_scenarios.py
```

Scenario:

- create a temp git repo
- dispatch a worker that inspects only and makes no changes

Expect:

- command exit code non-zero
- `runState: escalated`
- manifest contains `state: 'escalated'`
- manifest contains `cleanup: 'on_close'`
- dispatched worktree still exists after the command returns
- harness explicitly removes the retained worktree during teardown

### 4. Skill frontmatter is valid YAML

Command:

```bash
for f in skills/*/SKILL.md; do
  python3 - <<'PY' "$f"
import sys, pathlib, yaml
p = pathlib.Path(sys.argv[1])
text = p.read_text()
end = text.find('\n---\n', 4)
yaml.safe_load(text[4:end])
print(p)
PY
done
```

Expect:

- all skill files parse as YAML

### 5. Codex skill strict validation is still a known mismatch

Command:

```bash
python3 /Users/sjlee/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/relay-review
```

Current result:

- fails on extended frontmatter keys such as `argument-hint`, `compatibility`, `context`

Interpretation:

- this is a repo-wide skill-format mismatch with the strict Codex validator
- it is not a regression from the manifest foundation work
- the actual YAML syntax issue in `relay-review/SKILL.md` is fixed

## Out of Scope For These Tests

- script-driven review loop
- ready-to-merge default flow
- reviewer no-write enforcement
- manifest-driven merge behavior

Those belong to later issues in the lifecycle refactor.
