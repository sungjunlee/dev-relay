# Rubric — Documentation

Metrics a documentation specialist actually checks. Not "is the grammar correct" but "can someone with zero context complete a real task using only this document."

## Prerequisites (Hygiene)

Use this section only for checks that would apply to ANY PR in this repo. They gate the run and do not count toward factor totals.

| Check | Command | Target | Why it matters |
|-------|---------|--------|----------------|
| Docs lint baseline | `npx markdownlint-cli2 docs/**/*.md` or repo docs lint command | exit 0 | Repo-wide hygiene for documentation repos or docs-heavy projects. Keep it in `prerequisites`, not `factors`. |
| Docs link smoke | `npx lychee docs/` or project docs smoke command | exit 0 | Generic docs floor when every docs PR should pass it, not task-specific proof of quality. |

## Automated Checks (Contract-tier)

Most documentation checks are task-specific. Keep them in `factors` when they verify this document or workflow.

| Factor | Tier | Command | Target | Why it matters |
|--------|------|---------|--------|---------------|
| Links valid | `contract` | `npx markdown-link-check <file>` or `npx lychee <file>` | 0 broken links | A broken link in docs is a dead end. The reader came for an answer and got a 404. |
| Code examples run | `contract` | Extract and execute fenced code blocks | exit 0 | Docs with broken code examples are worse than no docs. They teach the wrong thing with authority. |
| No orphan references | `contract` | `grep -rn` for referenced files/functions that don't exist | 0 orphans | Renamed the function but forgot the docs? Now the reader is searching for something that doesn't exist. |
| Spelling/grammar | `contract` | `npx cspell <file>` or `aspell list < <file> \| wc -l` | ≤ baseline | Not vanity. Typos in technical docs erode trust. If you misspelled the flag name, does the command also work? |

## Evaluated Factors

These separate "wrote some docs" from "the reader actually succeeded."

### Zero-context completeness (target: ≥ 8/10)

tier: quality

The ultimate test: give this document to someone who knows nothing about the project. Can they complete the task?

- **No assumed knowledge**: "Run the migration" — which migration? Where? With what tool? Every step that requires knowledge not in the document is a dropout point.
- **Environment stated explicitly**: What OS, what versions, what must already be installed? "Requires Node.js" is insufficient. "Requires Node.js 18+ (check with `node --version`)" is complete.
- **Happy path AND failure path**: What does success look like? What does failure look like? If the reader follows the steps and something goes wrong, do they know what "wrong" looks like and what to try?

Scoring guide:
- **low**: Steps assume tools/context not mentioned, no version requirements, reader can't tell if they succeeded.
- **mid**: Steps complete and tools specified, but no failure path — reader only knows what success looks like, not what to do when it breaks.
- **high**: Zero-context reader can complete the task end-to-end, with explicit success/failure indicators and recovery steps.

### Reader testing (target: ≥ 8/10)

tier: quality

Simulate a fresh reader. Generate 5-10 questions that a real user would ask after reading this doc. Then answer them using ONLY the document content.

- **Questions answered**: How many of the 10 questions can be fully answered from the document alone? Target: ≥ 8/10.
- **Ambiguity check**: For each answered question, is the answer unambiguous? Or could a reasonable reader interpret it two different ways?
- **Gap identification**: The questions you CAN'T answer reveal the document's blind spots. These are the places where readers will get stuck, search elsewhere, or give up.

This is the documentation equivalent of autoresearch's `val_bpb` — a hard, repeatable metric that directly measures the thing that matters (reader success).

Scoring guide:
- **low**: Fewer than 6/10 questions answerable from doc alone, multiple ambiguous answers, obvious gaps in coverage.
- **mid**: 7-8/10 questions answerable, answers mostly unambiguous, but one or two reader journeys have dead ends.
- **high**: ≥ 9/10 questions answerable, unambiguous, gaps are edge cases not core paths.

### Information architecture (target: ≥ 7/10)

tier: quality

Structure is an argument. The order in which you present information shapes how the reader understands it.

- **Why before how**: If the reader doesn't understand WHY they're doing something, the HOW won't stick. "Run `npm run migrate`" is an instruction. "The database schema changed in v3; run `npm run migrate` to update your local schema" is understanding.
- **Progressive depth**: A skimmer should get value from headings alone. A reader should get value from the first paragraph of each section. A deep-diver should find the details they need without wading through basics. One document, three useful depths.
- **Scannable structure**: Headers, code blocks, tables, and lists are not decoration — they're navigation. A wall of prose in technical docs means the writer thought about writing, not about finding.

Scoring guide:
- **low**: Instructions without rationale, flat structure (no headings for sections), important info buried in paragraphs instead of highlighted.
- **mid**: Headings and code blocks present, but "why" is missing — reader follows steps mechanically without understanding.
- **high**: Why before how, progressive depth (skimmer → reader → deep-diver), scannable structure throughout.

### Maintenance resilience (target: ≥ 7/10)

tier: quality

Good docs stay accurate. Great docs are hard to make inaccurate.

- **Single source of truth**: If the same information appears in two places, one will drift. Does the document reference canonical sources (the code, the config, the CLI help) instead of duplicating them?
- **Version-stable language**: "Currently" and "recently" rot immediately. "As of v3.2" is stable. "See `--help` for current options" delegates to the source of truth.
- **Examples that test themselves**: Can the code examples be extracted and run as part of CI? If not, they'll drift. The best documentation is code that also reads well.

Scoring guide:
- **low**: Duplicated information across docs, "currently" language without dates/versions, examples that can't be validated.
- **mid**: Single source of truth for most info, version-stable language, but code examples not testable in CI.
- **high**: No duplication, all temporal language anchored to versions, examples extractable and CI-testable.

## Tool → Automated Check Mapping

| Tool | Automated check | Replaces evaluated |
|------|----------------|-------------------|
| markdown-link-check | `npx markdown-link-check *.md` → exit 0 | Link integrity |
| markdownlint | `npx markdownlint-cli2 *.md` → exit 0 | Structural consistency |
| `code-block-runner` / `mdsh` | Extract and run code examples → exit 0 | Example correctness |
| vale | `vale docs/` → 0 errors | Style guide compliance |
| `/browse` skill | Open rendered docs, verify navigation | Reader path walkthrough (partial) |
