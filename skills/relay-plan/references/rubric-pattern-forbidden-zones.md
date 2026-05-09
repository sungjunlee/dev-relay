# Rubric Pattern — Explicit Forbidden Zones

Use this pattern for any dispatch whose edit scope is narrower than "anywhere in the repo." Codex, given silence on what NOT to touch, will read silence as permission and apply broad changes — global string replacement, sed-style search-replace across cached snapshots, modifications of frozen sibling files. Every rubric must enumerate the paths that MUST NOT change.

## Failure mode

If the rubric only names what to change and stays silent on what to leave alone:

- Mechanical renames sweep through `backlog/` snapshots, falsifying historical issue titles.
- Schema additions modify a frozen helper "to add the missing field" because no other producer file is in scope.
- Surgical extensions to one module accidentally touch sibling files in the same skill.
- Doc edits cascade through "stale [oldname]" provenance phrases that exist precisely to record the rename's reason.

Each cycle costs at least one wasted dispatch, one review round catching the scope drift, and orchestrator-side cleanup (`git restore`, force-push, `rebrand-evidence.js`).

## Dogfood evidence (n=11, 2026-04 → 2026-05-08)

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

## What to enumerate

A `forbidden_zones` block lists glob patterns that are off-limits. Be explicit. Don't trust codex to infer. Categories that recur across dispatches:

- **Universal hands-off**: `backlog/**`, `**/*.cache/**`, `docs/issue-*.md`, `docs/*-2026-*.md`, `docs/*-2025-*.md`, `.github/workflows/**` — operational artifacts, point-in-time snapshots, CI/CD pipelines.
- **Frozen prior-PR contracts**: every helper file shipped by a prior PR that this dispatch only consumes (e.g., `skills/relay-dispatch/scripts/sidecar-store.js` after #372 ships its 5-field schema).
- **Sibling files in the same skill that aren't this PR's target**: when extending one module of a skill, list every other production file in the skill explicitly. Globs like `skills/<skill>/**` over-restrict; enumerate what stays read-only.
- **Test files in non-target areas**: tests for other skills should be off-limits even when production code changes ripple.
- **Cross-skill helpers imported as read-only**: when a script in skill A imports a helper from skill B, skill B's file is read-only for this dispatch unless the helper's API is the named target.

For each zone, the rubric lists either an exact path or a tight glob. Avoid wide globs like `skills/**` — they exclude legitimate edit zones.

## Pin the allowed zone too

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

## Worked example — surgical extension of an existing module (#376)

When the task extended `reliability-report.js` to add a `sidecar_insights` block but every other relay-dispatch file was frozen by prior PRs:

```yaml
forbidden_zones:
  - "backlog/**"
  - "**/*.cache/**"
  - "docs/issue-*.md"
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

## Subpattern — over-specification on frozen-scope helpers

A specific failure mode emerges when the DC requires a field on an event whose producer helper is in a forbidden zone (#374, PR #452, R1+R2+R3+R4). Two unsatisfying paths:

1. Modify the frozen helper → scope drift, R2 catches.
2. Bypass the helper from the runner → call the underlying primitive directly, re-implementing the event-shape responsibility in the caller.

Reviewers anchor to the frozen DC, not redispatch addendums, so flagging the gap each round even when the orchestrator says "drop the assertion" doesn't resolve it. Resolution requires either changing the AC pre-freeze or shipping the bypass implementation.

**Pre-flight check**: for every "Event X must include field Y" claim in the DC, verify X's producer is in the allowed-zone list. If not, either drop the field requirement or design the bypass before freezing the DC.

See `~/.claude/projects/<repo-slug>/memory/feedback_dc_overspec_frozen_helper.md` for the dogfood narrative.

## When to skip

Forbidden zones add overhead. For the smallest mechanical renames (one-file edits, no historical artifacts) where every production file in the repo is plausibly in the allowed scope, the universal hands-off list (`backlog/`, `*.cache/`, `docs/issue-*.md`, `.github/workflows/`) suffices. For anything larger or anything spanning more than two skills, enumerate explicitly.

## See also

- `rubric-design-guide.md` — overall rubric design guidance.
- `rubric-pattern-grep-token-precision.md` — sibling pattern for path/test/grep precision.
- `rubric-pattern-event-shape.md` — sibling pattern for event-schema evolution.
- `rubric-validation.md` — pre-dispatch validation checklist; forbidden_zones enumeration belongs in the same audit.
