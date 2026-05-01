# Rubric — Documentation

Documentation candidate axes for reader success, maintainability, and executable examples.

## Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical docs changes, one contract factor plus hygiene prerequisites is enough unless explicit AC, inferred Done Criteria, or concrete risk introduce real reader-success judgment.

## Hygiene Prerequisites

Use only when they apply to any docs PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Markdown lint | `npx markdownlint-cli2 docs/**/*.md` | exit 0 |
| Link baseline | `npx lychee docs/` or repo link check | exit 0 |
| Spelling baseline | `npx cspell docs/` | no new findings or `<= baseline` |

## Contract Axes

Use when they verify the changed document or workflow:

| Axis | Example command | Target |
|---|---|---|
| Links valid | `npx markdown-link-check <file>` | 0 broken links |
| Examples run | extract/run fenced code blocks | exit 0 |
| Referenced artifacts exist | `test -e <path>` or targeted grep | 0 orphan references |
| Required section present | `rg '<heading or token>' <file>` | expected content present |

## Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Zero-context completeness | prerequisites, exact steps, success/failure signs | a new reader can complete the workflow |
| Reader testing | likely questions answerable from the doc alone | core questions have unambiguous answers |
| Information architecture | order, headings, skimmability, why-before-how | readers can scan, then deepen |
| Maintenance resilience | source-of-truth links, version-stable wording, runnable examples | docs resist drift |

## Tool Mapping

Prefer markdown-link-check/lychee for links, markdownlint for structure, cspell/vale for language, and code-block runners for executable examples.
