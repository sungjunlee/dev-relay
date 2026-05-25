# Reviewer Policy - OpenCode

OpenCode is currently supported as:

- a dispatch executor;
- a primary reviewer through `--reviewer opencode` when route policy allows the selected model route;
- an advisory reviewer through `--advisory-reviewer opencode`;

OpenCode primary review is a merge-gating role, so it must return the normal review verdict JSON. Advisory OpenCode output can inform an operator or a trusted primary reviewer, but it never replaces the merge-gating verdict in standard review.

## Dispatch

OpenCode dispatch is experimental and write-capable. The adapter preserves the existing `opencode run` output path and passes model overrides through to the CLI. When no dispatch model is supplied, relay uses the bundled `references/executor-models.json` default and then optional `~/.relay/executors.json` overrides.

OpenCode does not provide relay-native sandbox or network containment. Dispatch policy metadata records this as informational rather than trusted enforcement.

## Advisory Review

OpenCode advisory review runs with a prompt-level read-only instruction and a detached worktree status guard. The result is recorded as advisory evidence only. Standard review does not let advisory output alter the trusted verdict or redispatch prompt. Hardened review may require advisory evidence, but the primary verdict still comes from a trusted primary reviewer.

## Primary Review Boundary

OpenCode primary review uses the same CLI transport with a phase-specific prompt and parser. Relay validates the result as primary verdict JSON, records adapter capability metadata as prompt-only/read-only with a post-run git status guard, and still requires route-policy approval before spawning `opencode`.

```bash
--reviewer opencode --reviewer-model opencode-go/deepseek-v4-pro
```

This does not claim live stable success for every OpenCode/model combination. Operators should treat policy approval as permission to try the route, then rely on review events, raw responses, and canary evidence before calling a live route healthy. A custom `--reviewer-script` remains an operator override and is audited separately from adapter-managed OpenCode primary review.
