# Risk-Proportional Assurance

Classify the task before choosing procedural depth. Model identity, provider, benchmark reputation, and reasoning level are not risk inputs.

## Required properties

The four properties are authority, reversibility, blast radius, and affected trust boundaries:

- `authority`: `read-only`, `workspace`, `external-write`, or `privileged`
- `reversibility`: `easy`, `bounded`, `difficult`, or `irreversible`
- `blast_radius`: `isolated`, `repository`, `multi-system`, or `broad`
- `trust_boundaries`: concrete affected boundaries such as authorization, secrets, deployment, persistent data, payments, or migration; use `[]` only when none are crossed

The highest applicable signal wins:

- High: external or privileged authority, difficult/irreversible recovery, multi-system/broad blast radius, or any affected trust boundary.
- Medium: bounded recovery or repository-wide blast radius without a high signal.
- Low: read-only/workspace authority, easy recovery, isolated blast radius, and no affected trust boundary.

Do not lower risk because the selected model is newer or stronger. An explicit assurance tier may strengthen the derived floor but must never undercut it.

## Assurance paths

| Risk | Assurance | Contract and evidence | Independent review |
|---|---|---|---|
| Low | `compact` | Compact Outcome Contract, mechanical Verification, optional truly earned quality factors | One post-publication independent review; a substantive failure escalates |
| Medium | `standard` | Fixed Outcome Contract, task-specific Verification, optional Earned Rubric | One bounded repair cycle: review, targeted repair, corrected-result review |
| High | `hardened` | Stronger SHA-bound evidence and explicit approvals for irreversible effects | Pre-publication review plus post-publication review; adversarial gating evidence is required |

The mapped review caps are 1, 2, and 3 respectively. Hardened handoffs use the existing `--publish-policy after-internal-review` path and a configured adversarial reviewer. Compact and standard use existing immediate publication. These are existing lifecycle routes, not new states.

Permission, sandbox, network, repository, SHA, audit, publication, and merge protections remain invariant across all three paths. Compact changes planning/review depth only: it does not grant network access, widen write scope, bypass repository isolation, weaken stale-SHA gates, suppress audit events, publish without the normal PR path, or auto-merge.

## Task Profile

```yaml
task_profile:
  authority: workspace
  reversibility: easy
  blast_radius: isolated
  trust_boundaries: []
  review_assurance: compact
```

`review_assurance` may be omitted when the four properties are present; dispatch derives it. If supplied, it must be at least the derived floor. Partial or unknown risk properties fail closed. Legacy profiles without the four properties remain readable during calibration.

For high risk, return a handoff command that includes:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . \
  --review-assurance hardened --publish-policy after-internal-review \
  --rubric-file /tmp/rubric.yaml --prompt-file /tmp/dispatch-prompt.md --json
```

Configure the hardened advisory lane through routing or relay-config; never choose a reviewer/model as a proxy for the risk classification.
