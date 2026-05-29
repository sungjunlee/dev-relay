## Rubric Pattern — Explicit Forbidden Zones

Use this pattern for any dispatch whose edit scope is narrower than "anywhere in the repo." Codex, given silence on what NOT to touch, will read silence as permission and apply broad changes — global string replacement, sed-style search-replace across cached snapshots, modifications of frozen sibling files. Every rubric must enumerate the paths that MUST NOT change.

### Failure mode

If the rubric only names what to change and stays silent on what to leave alone:

- Mechanical renames sweep through `backlog/` snapshots, falsifying historical issue titles.
- Schema additions modify a frozen helper "to add the missing field" because no other producer file is in scope.
- Surgical extensions to one module accidentally touch sibling files in the same skill.
- Doc edits cascade through "stale [oldname]" provenance phrases that exist precisely to record the rename's reason.

Each cycle costs at least one wasted dispatch, one review round catching the scope drift, and orchestrator-side cleanup (`git restore`, force-push, `rebrand-evidence.js`).

### Dogfood evidence (n=11, 2026-04 → 2026-05-08)

The pattern was originally derived from #434's mechanical-rename dispatch (`relay-intake` → `relay-ready`), where codex did a global `sed`-style replacement that corrupted 32 files including `backlog/triage/.cache/*.json` snapshots and the active sprint's "renamed from" provenance prose. After explicit `forbidden_zones` enumeration was added to every subsequent rubric, the next 10 PRs landed clean with zero forbidden-zone breaches:

| Date | PR | Issue | Scope | Outcome |
|---|---|---|---|---|
| 2026-05-07 | #444 | #434 | mechanical rename + shim | source for the pattern; corrupted before fix, clean after explicit zones |
| 2026-05-07 | #440 | #432 | spec-only doc PR | clean |
| 2026-05-07 | #443 | #433 | spec-only doc PR | clean |
| 2026-05-07 | #445 | #435 | new deterministic scorer | clean |
| 2026-05-08 | #447 | #436 | new module + state machine wiring | clean |
| 2026-05-08 | #446 | #437 | new probe CLI + chain offer | clean |
| 2026-05-08 | #448 | #372 | sidecar schema additions | clean |
| 2026-05-08 | #449 | #381 | new skill (`relay-sidecar`) | clean |
| 2026-05-08 | #450 / #451 | #373 / #376 | kind module / surgical extension | clean (one false start at #374 R2, caught by reviewer and reverted) |
| 2026-05-08 | #452 / #453 | #374 / #375 | kind modules | #374 had one R2 forbidden-zone touch → reverted in R3 |
| 2026-05-08 | #454 | #144 | new feature dir + matcher in existing skill | clean |

Pattern works across mechanical renames, schema additions, new-skill builds, kind-module additions, surgical extensions of existing modules, and feature-dir additions.

### What to enumerate

A `forbidden_zones` block lists glob patterns that are off-limits. Be explicit. Don't trust codex to infer. Categories that recur across dispatches:

- **Universal hands-off**: `backlog/**`, `**/*.cache/**`, `docs/archive/issues/issue-*.md`, `docs/*-2026-*.md`, `docs/*-2025-*.md`, `.github/workflows/**` — operational artifacts, point-in-time snapshots, CI/CD pipelines.
- **Frozen prior-PR contracts**: every helper file shipped by a prior PR that this dispatch only consumes (e.g., `skills/relay-dispatch/scripts/sidecar-store.js` after #372 ships its 5-field schema).
- **Sibling files in the same skill that aren't this PR's target**: when extending one module of a skill, list every other production file in the skill explicitly. Globs like `skills/<skill>/**` over-restrict; enumerate what stays read-only.
- **Test files in non-target areas**: tests for other skills should be off-limits even when production code changes ripple.
- **Cross-skill helpers imported as read-only**: when a script in skill A imports a helper from skill B, skill B's file is read-only for this dispatch unless the helper's API is the named target.

For each zone, the rubric lists either an exact path or a tight glob. Avoid wide globs like `skills/**` — they exclude legitimate edit zones.

### Pin the allowed zone too

Forbidden zones name what's off-limits. The dispatch prompt should ALSO name the positive list of allowed edit zones in plain prose, since that's what codex reads first. The two should match: any path NOT in the allowed list is in the forbidden list.

```yaml
forbidden_zones:
  - "skills/relay-dispatch/scripts/dispatch.js"
  - "skills/relay-dispatch/scripts/sidecar-store.js"
  - "skills/relay-dispatch/scripts/relay-events.js"
  # ... every other relay-dispatch script enumerated
  - "skills/relay-ready/**"
  - "skills/relay-plan/**"
  # ... and so on for every other skill
  # Allowed-zones (positive list): skills/relay-dispatch/scripts/reliability-report.js,
  # tests/relay-dispatch/scripts/reliability-report.test.js
```

The comment-style allowed-zones note at the bottom is a planning aid; the dispatch prompt repeats it in prose under a "Forbidden zones (rubric-enforced)" section so codex sees it before opening any file.

### Worked example — surgical extension of an existing module (#376)

When the task extended `reliability-report.js` to add a `sidecar_insights` block but every other relay-dispatch file was frozen by prior PRs:

```yaml
forbidden_zones:
  - "backlog/**"
  - "**/*.cache/**"
  - "docs/archive/issues/issue-*.md"
  - "docs/*-2026-*.md"
  - "docs/*-2025-*.md"
  - ".github/workflows/**"
  # Read-only relay-dispatch internals (the ONE allowed edit is reliability-report.js itself):
  - "skills/relay-dispatch/scripts/dispatch.js"
  - "skills/relay-dispatch/scripts/sidecar-store.js"
  - "skills/relay-dispatch/scripts/relay-events.js"
  - "skills/relay-dispatch/scripts/recover-commit.js"
  - "skills/relay-dispatch/scripts/manifest/**"
  - "skills/relay-dispatch/scripts/executors/**"
  # ... etc
  # Allowed-zones: skills/relay-dispatch/scripts/reliability-report.js (extend),
  # tests/relay-dispatch/scripts/reliability-report.test.js (extend additively).
```

PR #451 landed in 2 rounds (R1 changes_requested on prediction-heuristic precision, R2 PASS clean). Zero forbidden-zone breaches.

### Subpattern — over-specification on frozen-scope helpers

A specific failure mode emerges when the DC requires a field on an event whose producer helper is in a forbidden zone (#374, PR #452, R1+R2+R3+R4). Two unsatisfying paths:

1. Modify the frozen helper → scope drift, R2 catches.
2. Bypass the helper from the runner → call the underlying primitive directly, re-implementing the event-shape responsibility in the caller.

Reviewers anchor to the frozen DC, not redispatch addendums, so flagging the gap each round even when the orchestrator says "drop the assertion" doesn't resolve it. Resolution requires either changing the AC pre-freeze or shipping the bypass implementation.

**Pre-flight check**: for every "Event X must include field Y" claim in the DC, verify X's producer is in the allowed-zone list. If not, either drop the field requirement or design the bypass before freezing the DC.

See `~/.claude/projects/<repo-slug>/memory/feedback_dc_overspec_frozen_helper.md` for the dogfood narrative.

### When to skip

Forbidden zones add overhead. For the smallest mechanical renames (one-file edits, no historical artifacts) where every production file in the repo is plausibly in the allowed scope, the universal hands-off list (`backlog/`, `*.cache/`, `docs/archive/issues/issue-*.md`, `.github/workflows/`) suffices. For anything larger or anything spanning more than two skills, enumerate explicitly.

### See also

- `rubric-design-guide.md` — overall rubric design guidance.
- `rubric-patterns.md#rubric-pattern--file-path-and-grep-token-precision` — sibling pattern for path/test/grep precision.
- `rubric-patterns.md#rubric-pattern--event-shape-changes` — sibling pattern for event-schema evolution.
- `rubric-validation.md` — pre-dispatch validation checklist; forbidden_zones enumeration belongs in the same audit.

## Rubric Pattern — File-Path and Grep-Token Precision

Use this pattern whenever a rubric factor names a file path, a test name, or a `| grep` token list. Quality reviewers and automated `command:` factors enforce the EXACT string. Codex, given free naming choice, will pick a semantically-close but inflected or synonymous variant — and the factor fails.

### Failure modes

Three dogfood data points (rule of three met), one root cause at three different layers:

| Date | Issue | Layer | Failure |
|---|---|---|---|
| 2026-04 | #109 | Doc filename | Rubric: `docs/archive/issues/issue-109-per-agent-model-hints.md`. Codex wrote `…manifest-model-hints.md`. R2 quality FAIL; R3 1-line rename. |
| 2026-04-26 | #142 (PR #308) | Test file paths | Rubric prescribed 4 exact `tdd-*.test.js` paths; codex consolidated into topic files. All 4 automated factors FAILed "Could not find …". R3 added 4 shim files (8 lines). |
| 2026-05-02 | #393 (PR #403) | Grep verb inflection | Rubric: `\| grep -E '#393\|auto-recover-commit\|auto-recovered'`. Codex named test `auto-recovers …` — none of the three tokens match. R1 FAIL; rename. |

Each cycle costs ~1 wasted dispatch + 1 review round + 1 orchestrator commit.

### Pin the path

For factors that name a file (docs target, test path, generated artifact), write `Required path:` inline in the factor's intent block. Do not leave the filename implicit and do not list two synonyms.

```yaml
- name: Per-agent model hints documented
  tier: quality
  type: evaluated
  criteria: >
    Required path: docs/archive/issues/issue-109-per-agent-model-hints.md.
    Sections: "Why", "Manifest field", "Adapter mapping".
  weight: required
```

For automated factors that reference test FILES, write the exact filename in `command`. If flexibility is intentional, add a tolerance clause naming the equivalents:

```yaml
- name: Parser malformed-input contract
  type: automated
  command: "node --test tests/parser-frontmatter.test.js"
  target: "exit 0"
  # Tolerance: equivalent coverage in tests/parser/*.test.js is acceptable
  # iff it asserts the same four malformed-input shapes.
```

### Pin the test name (or absorb inflection)

For automated `command:` factors with `| grep TOKENS`, choose one:

(a) Prescribe the test name verbatim in the factor's intent block:

```yaml
criteria: >
  Required test name (verbatim): "dispatch auto-recover-commit emits
  recover_commit event when explicitly requested".
```

(b) Write the grep pattern to absorb verb inflection:

```yaml
command: >
  node --test … | grep -E '#393|auto-recover(s|ed|ing)?\b|--auto-recover-commit\b'
```

English verb inflection (`-s`, `-ed`, `-ing`) and noun-vs-phrase variation are the dominant miss patterns. Do not trust that codex's reasonable English naming will land in your token list.

### Pin the section inventory for docs mirrors

When the deliverable is a markdown doc, list mandated sections as an explicit bulleted inventory. Each bullet says what MUST appear.

```yaml
criteria: >
  docs/archive/issues/issue-N-feature.md MUST contain:
  - H1 "Feature: <name>"
  - Section "## Why" naming the triggering incident or memory
  - Section "## Behavior" enumerating each new flag/event
  - Section "## Recovery" cross-linking recovery-playbook.md
```

### Worked example

```yaml
- name: #393 auto-recover-commit visible in tests + docs
  tier: contract
  type: automated
  command: >
    node --test tests/relay-dispatch/scripts/auto-recover.test.js
    && grep -E 'auto-recover(s|ed|ing)?-commit\b|--auto-recover-commit\b' \
       skills/relay-dispatch/references/recovery-playbook.md
  target: "exit 0"
  weight: required
  criteria: >
    Required path: skills/relay-dispatch/references/recovery-playbook.md.
    Required test name (verbatim): "dispatch auto-recover-commit emits
    recover_commit event". Doc must contain section "## auto-recover-commit".
```

Reviewer applies, in order: path equality, test-name equality, grep regex tolerates verb inflection, section inventory complete.

### See also

- `rubric-design-guide.md` — overall rubric design guidance.
- `rubric-patterns.md#rubric-pattern--tdd-factor-flavor` — sibling pattern for red-first per-factor opt-in.
- `rubric-patterns.md#rubric-pattern--event-shape-changes` — sibling pattern for event-schema evolution.
- `rubric-validation.md` — pre-dispatch validation checklist; path/token precision belongs in the same audit.

## Rubric Pattern — TDD Factor Flavor

Use this pattern when one rubric factor should prove red-first work without turning the whole rubric into a TDD task.

### Field presence

Add `tdd_anchor: <path-string>` only to factors that need a red-first test. The field's presence is the opt-in signal.

Do not add a top-level `tdd_mode`. Non-TDD factors in the same rubric stay under the normal iteration and review rules.

### Runner resolution

Add `tdd_runner: <jest|pytest|mocha|vitest|...>` when the runner is clear. If it is omitted, the executor uses the first `test_infra` entry from `probe-executor-env.js --project-only --json`.

If no runner is available from either source, dispatch must stop before Step 0a with a clear error.

### Prerequisite exclusion

During Step 0a only, run each `rubric.prerequisites[].command` with the framework-native path-exclusion flag for every `tdd_anchor` path.

Do not modify `rubric.factors[].command`. If a prerequisite command has no native exclusion flag, stop instead of running it unfiltered or skipping it.

### Review relaxation

Reviewers may treat a non-HEAD commit whose subject starts with `tdd: red — ` as protocol evidence when HEAD resolves the introduced failures.

This relaxation applies only to factors carrying `tdd_anchor`. Outcome checks, quality checks, and non-TDD factors in the same rubric are reviewed normally.

**Worked example: parser validation**

```yaml
rubric:
  prerequisites:
    - command: "node --test"
      target: "exit 0"
  factors:
    - name: Parser rejects malformed front matter
      tier: contract
      type: automated
      command: "node --test tests/parser-frontmatter.test.js"
      target: "exit 0"
      weight: required
      tdd_anchor: "tests/parser-frontmatter.test.js"
      tdd_runner: "node:test"
    - name: Error message clarity
      tier: quality
      type: evaluated
      criteria: "Errors name the invalid key and the expected shape."
      target: ">= 8/10"
      weight: required
      scoring_guide:
        low: "Generic parse failure only."
        mid: "Names the invalid key but not the expected shape."
        high: "Names the invalid key, expected shape, and caller action."
```

Concrete checks:

- Field presence: only the parser contract factor carries `tdd_anchor`.
- Runner resolution: `tdd_runner` names the targeted test framework.
- Prerequisite exclusion: Step 0a excludes `tests/parser-frontmatter.test.js` from prerequisite commands only.
- Review relaxation: the red commit helps the parser contract factor only; `Error message clarity` is still reviewed under the normal quality standard.

### Why the rubric uses per-factor `tdd_anchor` and not a top-level `tdd_mode`

This pattern rejected the original #142 issue body's `tdd_mode: boolean` field in favor of per-factor `tdd_anchor` opt-in. Reasons:

- A top-level `tdd_mode: true` paired with zero factor-level `tdd_anchor` creates an architecturally impossible failure mode that requires a validator. Per `feedback_rubric_unreachable_path_clauses.md`, do not prescribe fallback for impossible states. Dropping `tdd_mode` deletes both the failure mode and the validator.
- Per-factor opt-in matches the reality that within one rubric some factors are TDD-appropriate (algorithmic, crisp specs) and others are not (text/docs/conventions/UI).
- The verdict-side strict-mode invariant test (PR #304 / #301) stays trivially green because the verdict schema is untouched.

The deviation is recorded under `done_criteria_source: planner_decision` in the persisted Done Criteria anchor at `~/.relay/runs/<repo-slug>/<run-id>/done-criteria.md`.

### Out of scope

- Top-level `tdd_mode: boolean` field (this pattern's primary deviation from #142's issue body).
- Adding `tdd_anchor`, `tdd_runner`, or any TDD-related field to the verdict schema.
- Per-commit CI gating; dev-relay reviews HEAD diff, not per-commit.
- Multiple `tdd: red — ` commits (one per factor); a single combined commit covers all anchors.
- Generalization to a "factor flavor" framework with multiple flavors (TDD + walking-skeleton + property-based + …); rule of three — generalize when a third flavor appears, not before.

### See also

- `skills/relay-plan/references/rubric-design-guide.md` — overall rubric design guidance and tier classification.
- `skills/relay-plan/scripts/tdd-suggestion.js` — TDD suggestion trigger and Quality Card line.
- `skills/relay-review/references/reviewer-prompt.md` § "TDD factor flavor" — reviewer-side regex gating and relaxation scope.

## Rubric Pattern — Event Shape Changes

Use this pattern when a quality factor concerns event schema evolution.
The rubric must name the complete event tuple, not just the newly added field.

### Field presence

Name the new marker field exactly and require the literal value expected. The
literal value proves the new shape was emitted by the intended path.

Do not write "includes the new marker." Write the assertion:

```yaml
criteria: "`review_apply` event includes `origin: \"system\"`"
```

### Field absence

Name related fields that must not appear when the event is system-generated.
This prevents implementations from satisfying the new field while preserving
an incompatible legacy shape.

For a system-forced review transition, the event must not invent reviewer-only
fields that imply a human or model review round ran.

### State context

Pin the event to the transition that generates it. Include `state_to`,
`state_from`, round number, or other tuple members needed to distinguish the
target event from similar emissions.

For escalation paths, require the terminal state and the policy reason rather
than checking only the event name.

### Legacy shape tolerance

Schema evolution rubrics must also protect old manifests and event journals.
State explicitly that pre-change events emitted without the new marker still
parse and retain their original meaning.

This is a compatibility assertion, not a request to backfill historical events.

**Worked example: `max_rounds_exceeded` -> `review_apply`**

For #228, the rubric factor should enumerate all four assertions:

```yaml
criteria: >
  When the review round cap is exceeded, the emitted `review_apply` event has
  `origin: "system"`, keeps reviewer-only fields absent, records
  `state_to: ESCALATED`, and records `reason: "max_rounds_exceeded"`.
  Legacy `review_apply` events emitted before `origin` existed still parse.
```

Concrete checks:

- Field presence: `origin` is present with the literal value `"system"`.
- Field absence: reviewer-only fields remain absent for the system transition.
- State context: `state_to: ESCALATED` and `reason: "max_rounds_exceeded"`.
- Legacy shape tolerance: older events without `origin` still parse correctly.
