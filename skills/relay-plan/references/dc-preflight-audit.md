# Pre-Flight DC Ambiguity Audit

Historical note: examples in this file describe prior relay runs and removed runtime surfaces; they are retained as wording-failure case studies, not current operator guidance.

Run this checklist after recovering Done Criteria (step 4 of `SKILL.md`) and before freezing the anchor for dispatch. It is narrower than `rubric-validation.md` § "Validate Done Criteria": that checklist asks whether each item is observable, bounded, reviewable, risk-aware, and verifiable. This one asks whether the wording leaves room for codex to ship a correct-looking implementation that still fails review on spec-precision.

The two checks compose: structural validation gates on the SHAPE of the DC; this audit gates on the WORDING.

## Failure mode

Across the 2026-05-08 marathon (8 PRs, 7 first-round changes_requested verdicts), every single R1 catch was a DC-precision/wording issue, not a logic bug. Codex implementations were correct; the implementation simply did not match the FULLY-INTENDED spec because the DC was ambiguous on one edge of meaning.

Each round of unintended ambiguity costs ~12 minutes (one dispatch + one review). #374 hit 4 rounds because the wording problem compounded with a frozen-scope helper (see § "Item 1" below).

Pre-flight DC review for hidden ambiguity has higher leverage than improving codex's correctness. The investment is in the planning step, not the execution step.

## Dogfood evidence (n=7, 2026-05-08)

| PR | Issue | R1 catch | Audit item |
|---|---|---|---|
| #448 | #372 | `output_path` scope under `artifacts/<id>/` (DC implied, didn't state) | 3 (implicit scope) |
| #449 | #381 | runner `--json` coupled to advisory output filename (DC said independent) | 4 (coupling default) |
| #450 | #373 | repeat-finding detector matched only `title` (AC said "title or body") | 2 (AND/OR boundary) |
| #451 | #376 | prediction heuristic full-title vs shared-substring (DC ambiguous) | 5 (heuristic precision) |
| #452 | #374 | `artifact_start trust_level` on frozen helper (AC6 over-spec) | 1 (frozen-helper field) |
| #453 | #375 | basename matching (AC test (a) used basename, codex full-path-only) | 5 (heuristic precision) |
| #454 | #144 | shipped `"no template scored above 0"` instead of literal `"no clear match"` | 6 (literal sentinels) |

#374 stretched to 4 rounds because AC6 also tripped item 1 (frozen helper). #375 applied item 1 explicitly in the DC and resolved clean in 2 rounds.

## The audit

### Item 1 — Event-field-on-frozen-helper

For each "Event X must include field Y" claim, verify X's producer helper is in this PR's allowed-edit zone. If the helper is in a forbidden zone (frozen contract from a prior PR), either drop the field requirement, OR specify a runner-side bypass path (e.g., "runner may call `appendRunEvent` directly with the field"), OR file the helper extension as a separate follow-up issue. The reviewer anchors to the FROZEN DC and will keep flagging the gap each round even when the orchestrator's redispatch addendum says "drop the assertion." Detail: `~/.claude/projects/<repo-slug>/memory/feedback_dc_overspec_frozen_helper.md`.

Worked: #374 AC6 said `artifact_start` includes `trust_level`. The producer helper was frozen by #372. R1+R2+R3 all flagged the gap. R4 landed via runner-side `appendRunEvent` bypass. Total cost: 2 extra cycles. #375 explicitly stated "DO NOT specify `trust_level` on the frozen start event" — clean R2 PASS.

### Item 2 — AND/OR boundary tightness

For each conjunction in an AC ("X and Y", "X or Y", "X / Y"), write the literal boolean. If the criterion is "match on title OR body", say so verbatim and add the failing-on-title-only test case to the AC. Codex tends to ship the narrower AND interpretation when "or" is implicit.

Worked: #373 AC said the repeat-finding detector should match "title or body" but the DC bullet hierarchy nested matching under "title-keyed dedup", which read AND-shaped. Codex shipped title-only. R1 catch.

### Item 3 — Implicit scope vs literal statement

For each scope claim implied by file paths or storage locations, write the literal directory/path. If outputs go under `artifacts/<run-id>/`, say so verbatim. If a generated artifact goes in `docs/`, name the directory. Codex defaults to top-level locations when scope is implicit.

Worked: #372 DC said "artifact lifecycle events store outputs at `output_path`" and showed the schema field, but did not literally say "all outputs MUST land under `artifacts/<run-id>/`". Codex picked a plausible top-level path. R1 catch.

### Item 4 — Coupling default

For each "independent vs coupled" axis (CLI flag + side effect, function arg + state mutation, schema field + invariant), state the default literally. Codex defaults to COUPLED when coupling reduces parameter count or simplifies the call shape. If the AC requires independence, say "X must remain independent of Y" and add the test that fails when they're coupled.

Worked: #381 AC said "runner `--json` flag controls report format only" and showed the advisory output filename as a separate field. Codex coupled them: `--json` switched both the report and the output filename. R1 catch.

### Item 5 — Heuristic precision

For each "match" or "detect" verb, name the exact comparison axis: full-string vs substring vs basename vs full-path vs prefix vs case-insensitive. Codex picks a reasonable axis but rarely the same one the DC author had in mind. Two examples in the same marathon (#376 and #375) confirms this is recurrent.

Worked: #376 prediction heuristic: DC said "title match"; codex shipped full-title equality, DC author meant shared-substring. #375 docs-sync: AC test (a) compared by basename, codex compared full-path. Both R1 catches.

### Item 6 — Literal sentinel strings

For forbidden phrases, empty-state output literals, and reviewer-anchor strings, prescribe verbatim text in the DC and put the string in quotes. Codex paraphrases reasonable English when given semantic instructions; reviewers anchor to literals.

Worked: #144 DC said the matcher should emit "no clear match" reason when no template scored. Codex shipped `"no template scored above 0"`. Same fail mode as #144's other catches around scaffold-guidance phrasing. R1 catch.

This pattern is also visible in #318/#319/#330's empty-state JSON shapes (`{ total_invocations: 0, ... }` spelled out verbatim) and in forbidden-phrase enumeration used by review-gate PRs (`"ready to merge"`, `"complete"`, `"all clear"`, `"LGTM"`, `"passed"`).

## Worked example — applying the audit pre-freeze

For #375 docs-sync, the planner ran items 1+5+6 explicitly during DC drafting:

- **Item 1**: `artifact_start` trust_level was dropped from the AC entirely (frozen helper from #372 -> no extension). Result: no R3+ rounds.
- **Item 5**: AC test (a) and (b) both spelled out the comparison axis ("test (a) compares by `path.basename`; test (b) compares by full path"). Result: no heuristic-precision R1.
- **Item 6**: Empty-state output spelled `"No likely stale docs detected."` verbatim with the period.

R1 still caught one issue (an unrelated full-path comparison in a different code path). R2 PASS clean. 2 rounds total — bull's-eye outcome. Compare #374's 4 rounds without the audit applied.

## When to skip

For S-size mechanical tasks with one observable outcome (rename a function, add a single literal to an enum, fix one regex), the audit is overkill — the AC has nowhere to be ambiguous. Skip when:

- Single-file edit, single observable change, no event/schema additions.
- All AC items map to one verbatim string the reviewer can grep for.
- No conjunctions, no scope claims, no heuristic verbs.

For everything else (M+, anything that adds events/schemas/kinds, anything that extends a frozen contract, anything with conjunctions or comparison verbs), the cost of one item-by-item walk is far below the cost of one extra round.

## See also

- `rubric-design-guide.md` — overall rubric design guidance; this audit precedes step Q1's source-model recovery.
- `rubric-validation.md` § "Validate Done Criteria" — structural DC checks (observable, bounded, reviewable). Composes with this audit.
- `rubric-patterns.md#rubric-pattern--explicit-forbidden-zones` — for enumerating read-only paths, sibling pattern to item 1.
- `rubric-patterns.md#rubric-pattern--file-path-and-grep-token-precision` — for path/test-name/grep-token literals, sibling pattern to item 6.
- `~/.claude/projects/<repo-slug>/memory/feedback_dc_overspec_frozen_helper.md` — origin memory for item 1.
