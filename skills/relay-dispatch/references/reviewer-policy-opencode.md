# Reviewer Policy - OpenCode

OpenCode is currently supported as:

- a dispatch executor;
- an advisory reviewer through `--advisory-reviewer opencode`;
- not a trusted primary reviewer.

`--reviewer opencode` must fail closed through the adapter registry until a trusted primary-review adapter exists and is tested. Advisory OpenCode output can inform an operator or a trusted primary reviewer, but it never replaces the merge-gating verdict.

## Dispatch

OpenCode dispatch is experimental and write-capable. The adapter preserves the existing `opencode run` output path and passes model overrides through to the CLI. When no dispatch model is supplied, relay uses the bundled `references/executor-models.json` default and then optional `~/.relay/executors.json` overrides.

OpenCode does not provide relay-native sandbox or network containment. Dispatch policy metadata records this as informational rather than trusted enforcement.

## Advisory Review

OpenCode advisory review runs with a prompt-level read-only instruction and a detached worktree status guard. The result is recorded as advisory evidence only. Standard review does not let advisory output alter the trusted verdict or redispatch prompt. Hardened review may require advisory evidence, but the primary verdict still comes from a trusted primary reviewer.

## Primary Review Boundary

OpenCode primary review is unsupported for now. The registry marks `primary_review` as unsupported with an explicit advisory-only reason, and policy audit metadata represents primary review requests as unsupported. Operators should use:

```bash
--reviewer codex --advisory-reviewer opencode
```

or another trusted primary reviewer. A custom `--reviewer-script` remains an operator override and is audited separately from adapter-managed OpenCode primary review.
