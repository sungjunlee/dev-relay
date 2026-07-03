# Comparison And Secondary Work

Comparison review, comparison implementation, parallel secondary work, and advisory context were handled as sidecar jobs in the removed sidecar experiment. They now map onto existing relay primitives, not a separate runtime.

## Selection Recipe

- **Comparison review** -> use `relay-review` with one primary reviewer and, when useful, an optional `--advisory-reviewer`. The primary review gates the run.
- **Comparison implementation** -> use `relay-fleet` or parallel `dispatch.js` calls that share the same Done Criteria file; review and promote one result.
- **Secondary work** -> if it is independently mergeable, make it an ordinary relay leaf or fleet leaf; if it is reviewer context only, pass it through advisory review input/output; if it is neither, keep it out of core relay.

Advisory artifacts are not primary merge evidence and do not gate merge unless `policy.review_assurance=hardened` requires them.

Comparison implementations use the same Done Criteria and review anchor so reviewers compare against one contract and promote exactly one result.

There is no new lifecycle branch, event name, or sidecar-like skill for these jobs.

## Advisory Comparison Review

Use a primary reviewer for the gating verdict and add a supported advisory reviewer for blind-spot evidence.

```bash
RUN_ID=<run-id>
PR_NUM=<pr-number>
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --reviewer codex --advisory-reviewer opencode --advisory-profile blindspot --json
```

Supported advisory reviewers are `opencode`, `pi`, and `antigravity`.

## Comparison Implementation

Use a fleet when the comparison candidates are already planned as leaves. Each leaf may vary branch, prompt, or executor, but the competing candidates share the same `done_criteria_file` and `rubric_file`.

```json
{
  "leaves": [
    {
      "leaf_ref": "candidate-a",
      "issue_number": 695,
      "branch": "compare-a",
      "prompt_file": "/tmp/compare-a.md",
      "rubric_file": "/tmp/comparison-rubric.yaml",
      "done_criteria_file": "/tmp/comparison-done.md",
      "executor": "codex"
    },
    {
      "leaf_ref": "candidate-b",
      "issue_number": 695,
      "branch": "compare-b",
      "prompt_file": "/tmp/compare-b.md",
      "rubric_file": "/tmp/comparison-rubric.yaml",
      "done_criteria_file": "/tmp/comparison-done.md",
      "executor": "opencode"
    }
  ]
}
```

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" \
  --repo . \
  --fleet-id comparison-695 \
  --leaves-file /tmp/comparison-695-leaves.json \
  --parallel 4
```

For a smaller comparison, dispatch ordinary leaves directly with the same anchors:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b compare-a --prompt-file /tmp/compare-a.md --rubric-file /tmp/comparison-rubric.yaml --done-criteria-file /tmp/comparison-done.md --executor codex
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b compare-b --prompt-file /tmp/compare-b.md --rubric-file /tmp/comparison-rubric.yaml --done-criteria-file /tmp/comparison-done.md --executor opencode
```

## Operator Boundary

Do not create comparison-only states, events, manifests, dashboards, or scoring layers. If a job cannot be expressed as advisory evidence, a fleet leaf, or an ordinary relay leaf, it is outside the relay lifecycle.
