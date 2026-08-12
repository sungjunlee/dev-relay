# Rubric — Fail-Closed Pattern Library

Use this reference when a task touches a relay gate, resolver selector, recovery path, audit stamp, or other invariant where a visible warning is not enough. These rules are distilled operating guidance; keep historical PR narratives out of this file so it remains usable inside the installed skill.

## Apply these rules

1. **Split visibility from enforcement.** If an invariant must be visible to the operator and must block unsafe progress, write separate factors for the prompt/warning layer and the state-transition or gate layer. Prompt text is not a gate.

2. **Validate the trust root, not only the derived field.** Path containment, anchor, and immutable-run-field factors need companion factors for the base value that makes the check meaningful. Enumerate sibling fields in the same run-record scope when they feed the same filesystem, GitHub, dispatch, review, merge, or cleanup consumer.

3. **Enumerate the state axis.** For derived-action-gated behavior, list every relevant action at the enforcement point. Prefer an explicit whitelist for allowed actions when stale or tampered run records must fail closed.

4. **Audit sibling selectors and call sites.** When fixing one resolver selector or helper call site, enumerate every selector that feeds the same downstream match set and every call site of the affected helper in the same file. A fix scoped only to the surfaced call site is usually undersized.

5. **Prove recovery end to end.** If a factor promises operator recovery or actionable next steps, require a regression that exercises the documented command flow. A non-terminal state plus printed instructions is not enough if the command rejects that state.

6. **Treat repeated invariant escapes as a planning signal.** If three or more consecutive review or post-merge challenges find new bypasses in the same invariant family, stop writing narrow follow-ups and create a broader cross-cutting issue or ask the operator to choose the next scope.

7. **Distinguish exclusion from detection.** Exclusion sites that filter records by state should use a whitelist derived from known states. Detection sites that classify known terminal states may use blacklist-style checks, but must carry an inline comment explaining why the asymmetry is intentional.

8. **Split timeout policy by downstream consumer.** For lock, deadline, or contention fallthrough paths, enumerate every consumer of the fallthrough output. A timeout policy that is safe for audit logging may still be unsafe for merge gating.

## Rubric checklist

Before dispatch, confirm the rubric names:

- The exact enforcement layer or `file:function` gate for each fail-closed claim.
- The state, selector, field, or consumer axis being enumerated.
- The regression command or evaluated evidence that proves the unsafe path blocks.
- Any deliberately deferred sibling axis, with a linked follow-up issue.

If a factor only says "warns", "documents", "surfaces", or "prints recovery guidance", it is not a fail-closed factor unless another factor names the blocking gate.
