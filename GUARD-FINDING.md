# Guard Finding for #766

The required pre-deletion guard found a reference outside the allowed set of
the four target scripts, their four tests, and the two cli-schema surfaces.

Per the dispatch instructions, no deletion was performed.

## Command

```bash
grep -rn "reliability-report-consumer\|probe-executor-env-consumer\|run-qa-loop\|analyze-flip-flop-pattern" skills tests README.md CLAUDE.md references
```

## Finding

`references/install-graph.md` documents `scripts/analyze-flip-flop-pattern.js`,
which is outside the allowed deletion-surface hits.

## Verbatim Output

```text
skills/relay-review/scripts/analyze-flip-flop-pattern.js:56:  commandName: "analyze-flip-flop-pattern",
skills/relay-review/scripts/analyze-flip-flop-pattern.js:62:  const unknownFlags = findUnknownFlags(args, "analyze-flip-flop-pattern");
skills/relay-review/scripts/analyze-flip-flop-pattern.js:66:  const positionals = getPositionals(args, "analyze-flip-flop-pattern");
skills/relay-review/scripts/analyze-flip-flop-pattern.js:101:  console.log("Usage: analyze-flip-flop-pattern.js [options]");
skills/relay-dispatch/scripts/cli-schema.js:125:  "analyze-flip-flop-pattern": [
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:12:} = require("../../../skills/relay-review/scripts/analyze-flip-flop-pattern");
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:14:const SCRIPT_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "analyze-flip-flop-pattern.js");
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:15:const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "analyze-flip-flop-pattern");
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:132:test("analyze-flip-flop-pattern/parseArgs keeps the default print mode and validates post-comment requirements", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:143:test("analyze-flip-flop-pattern classifies progressive, thrash, no-flip, and data-gap runs from the baseline fixture", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:163:test("analyze-flip-flop-pattern ignores not_run and missing-factor gaps when looking for flip-flops", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:175:test("analyze-flip-flop-pattern detects a sliding-window flip that only appears in rounds 2-4", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:188:test("analyze-flip-flop-pattern excludes old runs and one-round runs from the in-scope denominator", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:200:test("analyze-flip-flop-pattern records explicit data-gap reasons for missing repeated_issue_count, missing manifest, and invalid verdict JSON", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:213:test("analyze-flip-flop-pattern classifies missing verdict-file round gaps as data_gap", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:228:test("analyze-flip-flop-pattern classifies terminal missing manifest rounds as data_gap", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:244:test("analyze-flip-flop-pattern reports mixed flip and stable factors without inventing stable-factor flips", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:258:test("analyze-flip-flop-pattern ignores skipped statuses when counting pass/fail transitions", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:271:test("analyze-flip-flop-pattern renderReport emits the required headings and percentage output", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:289:test("analyze-flip-flop-pattern renderReport uses n/a when there are no flip-flop runs in the window", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:304:test("analyze-flip-flop-pattern CLI --help lists every supported flag", () => {
tests/relay-review/scripts/analyze-flip-flop-pattern.test.js:316:test("analyze-flip-flop-pattern CLI --post-comment sends the rendered report to gh issue comment", () => {
tests/relay-dispatch/scripts/cli-schema.test.js:146:  ["analyze-flip-flop-pattern", path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "analyze-flip-flop-pattern.js")],
tests/relay-ready/scripts/run-qa-loop.test.js:8:} = require("../../../skills/relay-ready/scripts/run-qa-loop");
tests/relay-ready/scripts/run-qa-loop.test.js:10:const VERIFIABILITY_LOW_BODY = `Update \`skills/relay-ready/scripts/run-qa-loop.js\` so the sequential Q&A loop returns deterministic action objects for a caller that stores answers externally.
tests/relay-ready/scripts/run-qa-loop.test.js:121:  assert.match(helperCalls[0][2], /tests\/relay-ready\/scripts\/run-qa-loop\.test\.js/);
tests/relay-ready/scripts/run-qa-loop.test.js:146:  }, ["`tests/relay-ready/scripts/run-qa-loop.test.js` passes and the event ledger lists Q&A events in order."]);
tests/relay-ready/scripts/run-qa-loop.test.js:184:  assert.match(helperCalls[2][2], /run-qa-loop\.test\.js/);
tests/relay-ready/scripts/run-qa-loop.test.js:253:  }, ["`tests/relay-ready/scripts/run-qa-loop.test.js` passes after the override is applied."]);
tests/relay-plan/scripts/probe-executor-env-consumer.test.js:12:} = require("../../../skills/relay-plan/scripts/probe-executor-env-consumer");
tests/relay-plan/scripts/reliability-report-consumer.test.js:13:} = require("../../../skills/relay-plan/scripts/reliability-report-consumer");
references/install-graph.md:30:| `relay-review` | `relay-dispatch` | Review entrypoints and helpers import dispatch manifest/event modules: `scripts/review-runner.js` requires `../../relay-dispatch/scripts/manifest/lifecycle`, `manifest/paths`, `manifest/rubric`, `manifest/store`, `relay-events`, and `cli-args`; nested `scripts/review-runner/*` modules require `../../../relay-dispatch/scripts/...`; reviewer adapters require `../../relay-dispatch/scripts/cli-args`; `scripts/reviewer-helpers.js` and `scripts/analyze-flip-flop-pattern.js` also require dispatch modules. | Use `npx skills add sungjunlee/dev-relay` for the full bundle. Per-skill installs are not operator-supported. |
```
