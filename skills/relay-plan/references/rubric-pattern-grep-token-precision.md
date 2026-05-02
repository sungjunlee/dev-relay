# Rubric Pattern — File-Path and Grep-Token Precision

Use this pattern whenever a rubric factor names a file path, a test name, or a `| grep` token list. Quality reviewers and automated `command:` factors enforce the EXACT string. Codex, given free naming choice, will pick a semantically-close but inflected or synonymous variant — and the factor fails.

## Failure modes

Three dogfood data points (rule of three met), one root cause at three different layers:

| Date | Issue | Layer | Failure |
|---|---|---|---|
| 2026-04 | #109 | Doc filename | Rubric: `docs/issue-109-per-agent-model-hints.md`. Codex wrote `…manifest-model-hints.md`. R2 quality FAIL; R3 1-line rename. |
| 2026-04-26 | #142 (PR #308) | Test file paths | Rubric prescribed 4 exact `tdd-*.test.js` paths; codex consolidated into topic files. All 4 automated factors FAILed "Could not find …". R3 added 4 shim files (8 lines). |
| 2026-05-02 | #393 (PR #403) | Grep verb inflection | Rubric: `\| grep -E '#393\|auto-recover-commit\|auto-recovered'`. Codex named test `auto-recovers …` — none of the three tokens match. R1 FAIL; rename. |

Each cycle costs ~1 wasted dispatch + 1 review round + 1 orchestrator commit.

## Pin the path

For factors that name a file (docs target, test path, generated artifact), write `Required path:` inline in the factor's intent block. Do not leave the filename implicit and do not list two synonyms.

```yaml
- name: Per-agent model hints documented
  tier: quality
  type: evaluated
  criteria: >
    Required path: docs/issue-109-per-agent-model-hints.md.
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

## Pin the test name (or absorb inflection)

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

## Pin the section inventory for docs mirrors

When the deliverable is a markdown doc, list mandated sections as an explicit bulleted inventory. Each bullet says what MUST appear.

```yaml
criteria: >
  docs/issue-N-feature.md MUST contain:
  - H1 "Feature: <name>"
  - Section "## Why" naming the triggering incident or memory
  - Section "## Behavior" enumerating each new flag/event
  - Section "## Recovery" cross-linking recovery-playbook.md
```

## Worked example

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

## See also

- `rubric-design-guide.md` — overall rubric design guidance.
- `rubric-pattern-tdd-flavor.md` — sibling pattern for red-first per-factor opt-in.
- `rubric-pattern-event-shape.md` — sibling pattern for event-schema evolution.
- `rubric-validation.md` — pre-dispatch validation checklist; path/token precision belongs in the same audit.
