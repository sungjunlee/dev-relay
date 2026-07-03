# Comparison And Secondary Work

Comparison review, comparison implementation, parallel secondary work, and advisory context were handled as sidecar jobs in the removed sidecar experiment. They now map onto existing relay primitives, not a separate runtime.

## Selection Recipe

- **Comparison review** -> use `relay-review` with one primary reviewer and, when useful, an optional `--advisory-reviewer`. The primary review gates the run.
- **Comparison implementation** -> dispatch parallel `dispatch.js` leaves that share the same Done Criteria file; review and promote one result. `relay-fleet` fits only when each candidate is modeled as its own issue, because fleet admission enforces a unique `issue_number` per leaf.
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

Dispatch the competing candidates as ordinary parallel leaves. The candidates may vary branch, prompt, or executor, but they share the same `--done-criteria-file` and `--rubric-file`; review and promote one result.

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b compare-a --prompt-file /tmp/compare-a.md --rubric-file /tmp/comparison-rubric.yaml --done-criteria-file /tmp/comparison-done.md --executor codex
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b compare-b --prompt-file /tmp/compare-b.md --rubric-file /tmp/comparison-rubric.yaml --done-criteria-file /tmp/comparison-done.md --executor opencode
```

Keep candidate branch names issue-neutral (`compare-a`, not `issue-695-a`) so the dispatch in-flight run check does not treat the candidates as conflicting runs on one issue.

Do not put same-issue comparison candidates in a fleet: fleet issue-lock admission rejects duplicate `issue_number` values across leaves, so competing candidates for one issue are not admissible fleet leaves. Use `relay-fleet` for comparison work only when each candidate is modeled as its own issue; the leaves may still share `done_criteria_file` and `rubric_file`:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" \
  --repo . \
  --fleet-id comparison-epic-42 \
  --leaves-file /tmp/comparison-epic-42-leaves.json \
  --parallel 4
```

## Operator Boundary

Do not create comparison-only states, events, manifests, dashboards, or scoring layers. If a job cannot be expressed as advisory evidence, a fleet leaf, or an ordinary relay leaf, it is outside the relay lifecycle.
