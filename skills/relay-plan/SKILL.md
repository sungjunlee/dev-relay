---
name: relay-plan
argument-hint: "[task, issue, or ready handoff]"
description: Use when a relay run needs its review anchor, evaluation channels, or dispatch prompt — always before relay-dispatch, whether AC are explicit, vague, or missing.
compatibility: Requires Git and Node.js 18+; gh CLI is needed only for the supported GitHub route.
metadata:
  related-skills: "relay, relay-ready, relay-dispatch, relay-review, dev-backlog"
  keywords: "계획, 평가, 루브릭, planning, evaluation, rubric, dispatch prompt"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`.
- Files: relay-ready handoff, task file, issue/user text, optional local harness context (`AGENTS.md`, `CLAUDE.md`, `CHARTER.md`, `spec/capabilities.md`, active sprint notes), optional `/tmp/done-criteria-<N>.md`, `/tmp/dispatch-<N>.md`, and compatibility-named `/tmp/rubric-<N>.yaml` evaluation artifact.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-plan/scripts/probe-executor-env.js`, `${RELAY_SKILL_ROOT:-skills}/relay-plan/scripts/persist-done-criteria.js`, `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`.

# Relay Plan

## Use when

- Building the review anchor, structured evaluation channels, and dispatch prompt for a relay run
- Converting task intent, explicit AC, repo signals, and risk into reviewable Done Criteria
- Persisting planner-authored Done Criteria before dispatch

## Do not use when

- Shaping an ambiguous task before planning — use `relay-ready`
- Delegating implementation to an executor — use `relay-dispatch`
- Reviewing executor output — use `relay-review`
- Landing a reviewed GitHub change — use `relay-merge`

`relay-plan` emits handoff artifacts only; `relay` or an operator runs `relay-dispatch`.

## Default Path

### 1. Read the task

Consume the route selected by `/relay`'s source gate before reading task
evidence. A no-remote Git checkout is local Reviewed Result delivery and must
use local task text or the user description without a forge lookup. The
supported GitHub route may use `gh` for issue text after the source gate.

Read the normalized task source (try in order, use first that succeeds):
- Relay-ready handoff brief: `~/.relay/requests/<repo-slug>/<request-id>/relay-ready/<leaf-id>.md`
- Local task file: `backlog/tasks/{PREFIX}-{N} - {Title}.md`
- GitHub on the selected GitHub route: `gh issue view <N>`
- User-provided description

If `relay-ready` produced a handoff brief, treat it as the source of truth instead of re-reading the raw request.
For a shaped leaf, consume that persisted `relay-ready/<leaf-id>.md` plus its frozen Done Criteria path; the
raw request is historical context only and must not be silently reinterpreted into a different task.
If the relay-ready anchor is incomplete, surface the ambiguity or persist planner-authored Done Criteria under Step 7.

### 2. Gather planning signals

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-plan/scripts/probe-executor-env.js" . --project-only --json
```

Read repo-local quality signal and task-relevant local harness context as weak inputs only. They inform wording, prerequisites, commands, and where to look; they do not gate dispatch or override the task. Field meanings and authority hierarchy: `references/signals.md`.

### 3. Normalize planning inputs

Keep explicit AC, inferred Done Criteria, relay-ready handoff, project harness context, repo signal, optional subsystem scout notes, and task risk as separate evidence channels until the review anchor is written.

### 4. Recover Done Criteria

Identify the evaluation source model:
- Explicit AC from the task source, when present
- Inferred Done Criteria from user intent, issue body, relay-ready handoff, and nearby repo conventions
- Repo signals from probes, available commands, and task-relevant conventions
- Task-specific risk from touched domains, trust boundaries, data loss, migrations, UX flows, or operational failure modes

If AC are missing, vague, or incomplete, write observable Done Criteria first. Treat explicit AC as high-priority evidence, not the only source. Before freezing, run the [pre-flight ambiguity audit](references/dc-preflight-audit.md). If the final review anchor is planner-authored or differs from the task source, persist it in step 7.

### 5. Build the evaluation channels

Keep Outcome Contract, Verification, and optional Earned Rubric separate according to `references/evaluation-channels.md`. The frozen Done Criteria are the contract. Minimal artifact:

```yaml
evaluation:
  schema_version: 2
  outcome_contract:
    source: done_criteria
  verification:
    checks:
      - name: Focused behavior passes
        type: command
        command: "<task-specific command>"
        target: "<observable pass condition>"
  earned_rubric:
    factors: []
```

Tests, builds, type checks, lint, artifact existence, and other binary evidence belong under Verification. Zero Earned Rubric factors is valid. A factor is earned only when Gradient, Observable, Actionable, and Consequential all hold; use qualitative weak/adequate/strong anchors before any optional numeric mapping. See `references/evaluation-channels.md`.
Observe before deriving quality: identify the artifact, intended user, usage context, and available surfaces, then use optional questions from `references/observation-lenses.md`.

### 6. Validate and simplify the channels

Quick gate before handoff: Outcome Contract items are binary and observable; Verification checks name concrete evidence; Earned Rubric may be empty and contains no routine hygiene. Full checklist: `references/rubric-validation.md`.

Before persisting, apply `references/rubric-simplification.md`: rewrite HOW into observable WHAT, merge overlaps, remove unsupported defensive clauses, and verify weights.

### 7. Persist planner-authored Done Criteria when needed

Persist only when planning writes the final Done Criteria, or expands, rejects, or narrows issue-body AC. This includes AC-missing inputs, user-provided descriptions, and any case where planning changes the issue-body AC.

Publish the final bytes to an explicit path whose parent directory already exists and is not a symlink. This step never allocates a run id and rejects output under `~/.relay/runs`; dispatch creates the run and freezes these bytes later.

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-plan/scripts/persist-done-criteria.js" \
  --output /tmp/done-criteria-<N>.md --file /tmp/done-criteria-source-<N>.md --json
```

Skip this step when the issue or relay-ready handoff already provides the final Done Criteria without planner changes.

### 8. Emit handoff artifacts

Write the dispatch prompt and evaluation YAML to temp files. The prompt uses `../relay/references/prompt-template.md` and appends Setup, optional Working Guidance, Evaluation Channels, and Completion Responsibilities. Pass the evaluation artifact through the compatibility-named `--rubric-file`; `references/iteration-protocol.md` defines the compact evidence-and-commit contract plus optional TDD flavor.

Before writing the prompt, resolve the target executor's dispatch toolset with `relay-config check --executor <name> --phase dispatch --json`. When `capability.commandExecution` is `false` the executor has no shell and dispatch rejects a command-demanding prompt: emit `../relay/references/prompt-template-shell-free.md`, whose Returned Verification and Completion Responsibilities replace the base Test-run Discipline and Completion Responsibilities. Otherwise keep the base contract verbatim. When the frozen Done Criteria itself names a command line, no template clears the gate: route that task to a shell-capable executor rather than emitting the shell-free contract or rewording the criteria.

Return a handoff summary with dispatch prompt path, rubric YAML path, Done Criteria anchor path when persisted, and the recommended `relay-dispatch` command.

Use `relay-config doctor` or `relay-config check` to validate an explicit adapter/model selection; relay-config has no mutable route catalog or defaults.

When Step 7 persisted Done Criteria, the dispatch handoff must preserve both anchors:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . \
  --branch issue-<N>-<slug> --prompt-file /tmp/dispatch-<N>.md --rubric-file /tmp/rubric-<N>.yaml \
  --done-criteria-file <done-criteria-path>
```

Do not run `relay-dispatch` from `relay-plan`.

## Risk-Triggered Add-Ons

Use add-ons only when task evidence earns them; do not copy reference checklists into the prompt.

- Rubric template scaffold: read `references/rubric-templates/_index.json`, then pick the template whose `signals` (`test_infra`, `type_check`, `lint_format`) overlap the Step 2 probe output; with no overlap, write the rubric from the task instead. A template is a starting scaffold to adapt by hand, never auto-applied and never the contract.
- TDD-flavored factors: a factor carries `tdd_anchor: <test path>` (optional `tdd_runner`) only when red-first testing fits that factor — crisp behavior, one specific path, and a runner that can target it. Suggest it when the Step 2 probe reports a usable test runner and an automated contract factor has no anchor yet; leave documentation, prose, UI judgment, and broad design factors unanchored. A `tdd_anchor` factor with no resolvable runner fails closed before Step 0a: `references/iteration-protocol.md`.
- `task_profile` or working guidance: `references/task-profile.md` and `references/guidance-packs.md`.
- Domain rubric ideas: `references/rubric-domain-axes.md`.
- Observation-first domain questions: `references/observation-lenses.md`.
- Trust boundaries and fail-closed behavior: `references/rubric-trust-model.md` and `references/rubric-fail-closed-patterns.md`.
- File/path precision, forbidden zones, event-shape changes, or TDD-flavored factors: `references/rubric-patterns.md`.
- L/XL ambiguity or unclear subsystem boundaries: consider a read-only scout via `references/subsystem-scout.md`; skip for S/M tasks with clear scope.
- Novel, vague, high-risk, or easy-to-game Done Criteria: run one stress-test round via `references/rubric-stress-test.md`; ambiguity or risk can opt any size into stress-test.
- Re-dispatch after review feedback: keep the original anchor fixed; previous attempt evidence and reviewer feedback are automatically prepended. Legacy Score Log text remains readable during migration but executor-authored scores are not review evidence.
