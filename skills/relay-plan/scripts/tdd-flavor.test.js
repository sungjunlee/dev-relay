// canary: bare-string `event === "..."` reader assertions in this file are deliberate canaries against EVENTS schema drift; do not port to EVENTS.X (see #313).
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  TDD_COMMIT_PREFIX,
  applyTddFlavorToDispatchPrompt,
  extractAllFactors,
  extractTddFactors,
  hasTddAnchor,
  renderIterationProtocolForRubric,
  resolveTddFactors,
} = require("./tdd-flavor");
const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");
const { readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
const { createEnforcementFixture } = require("../../relay-dispatch/scripts/test-support");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../relay-review/scripts/review-runner/execution-evidence");

const BASELINE_PROMPT_PATH = path.join(__dirname, "..", "__fixtures__", "dispatch-prompt-baseline", "non-tdd.md");
const REVIEW_RUNNER_SCRIPT = path.join(__dirname, "..", "..", "relay-review", "scripts", "review-runner.js");
const FINALIZE_RUN_SCRIPT = path.join(__dirname, "..", "..", "relay-merge", "scripts", "finalize-run.js");
const REVIEW_COMMENT_DATE = "2026-04-03T08:00:00Z";

const NON_TDD_RUBRIC = [
  "rubric:",
  "  factors:",
  "    - name: Documentation completeness",
  "      tier: contract",
  "      type: evaluated",
  "      target: \">= 8/10\"",
].join("\n");

const TDD_RUBRIC = [
  "rubric:",
  "  prerequisites:",
  "    - command: \"node --test\"",
  "      target: \"exit 0\"",
  "  factors:",
  "    - name: Parser rejects invalid input",
  "      tier: contract",
  "      type: automated",
  "      command: \"node --test tests/parser.test.js\"",
  "      target: \"exit 0\"",
  "      weight: required",
  "      tdd_anchor: \"tests/parser.test.js\"",
  "      tdd_runner: \"node:test\"",
  "    - name: Error copy is actionable",
  "      tier: quality",
  "      type: evaluated",
  "      target: \">= 8/10\"",
].join("\n");

const PROBE_WITH_TEST_INFRA = JSON.stringify({
  test_infra: [{ name: "node:test" }],
  project_tools: { frameworks: [{ name: "jest", source: "package.json" }] },
});

test("non-TDD rubric leaves dispatch prompt byte-identical to baseline", () => {
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");

  const rendered = applyTddFlavorToDispatchPrompt({
    dispatchPrompt: baseline,
    rubricYaml: NON_TDD_RUBRIC,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.equal(rendered, baseline);
});

test("TDD rubric inserts Step 0a, preserves existing Step 0 numbering, and scopes Step 4 relaxation", () => {
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");

  const rendered = applyTddFlavorToDispatchPrompt({
    dispatchPrompt: baseline,
    rubricYaml: TDD_RUBRIC,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.match(rendered, /0a\. TDD RED ANCHOR STEP/);
  assert.match(rendered, new RegExp(TDD_COMMIT_PREFIX));
  assert.match(rendered, /tests\/parser\.test\.js/);
  assert.match(rendered, /Do not modify `rubric\.factors\[\]\.command`/);
  assert.match(rendered, /this relaxation applies only to factors carrying `tdd_anchor`; other factors in the same rubric are reviewed under the existing rule/);
  assert.ok(rendered.indexOf("0a. TDD RED ANCHOR STEP") < rendered.indexOf("  0. PREREQUISITE GATE"));
  assert.match(rendered, /  0\. PREREQUISITE GATE/);
});

test("empty tdd_anchor values do not activate Step 0a", () => {
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");
  const emptyAnchorRubric = [
    "rubric:",
    "  factors:",
    "    - name: Empty double-quoted anchor",
    "      tdd_anchor: \"\"",
    "      tdd_runner: \"node:test\"",
    "    - name: Empty single-quoted anchor",
    "      tdd_anchor: ''",
    "      tdd_runner: \"node:test\"",
  ].join("\n");

  const rendered = applyTddFlavorToDispatchPrompt({
    dispatchPrompt: baseline,
    rubricYaml: emptyAnchorRubric,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.equal(hasTddAnchor(emptyAnchorRubric), false);
  assert.deepEqual(resolveTddFactors({
    rubricYaml: emptyAnchorRubric,
    probeSignal: PROBE_WITH_TEST_INFRA,
  }), []);
  assert.equal(rendered, baseline);
});

test("extractAllFactors returns every factor regardless of tdd_anchor presence", () => {
  const rubric = [
    "rubric:",
    "  factors:",
    "    - command: \"node --test tests/parser.test.js\"",
    "      tier: contract",
    "      type: automated",
    "      name: Parser rejects invalid input",
    "      tdd_anchor: \"tests/parser.test.js\"",
    "      tdd_runner: \"node:test\"",
    "    - type: evaluated",
    "      name: Error copy is actionable",
    "      tier: quality",
  ].join("\n");
  const factors = extractAllFactors(rubric);

  assert.deepEqual(factors.map((factor) => ({
    name: factor.name,
    tier: factor.tier,
    type: factor.type,
    tdd_anchor: factor.tdd_anchor,
    tdd_runner: factor.tdd_runner,
  })), [
    {
      name: "Parser rejects invalid input",
      tier: "contract",
      type: "automated",
      tdd_anchor: "tests/parser.test.js",
      tdd_runner: "node:test",
    },
    {
      name: "Error copy is actionable",
      tier: "quality",
      type: "evaluated",
      tdd_anchor: null,
      tdd_runner: null,
    },
  ]);
});

test("extractAllFactors carries fix_hint additively without changing TDD projections", () => {
  const rubric = [
    "rubric:",
    "  factors:",
    "    - name: Parser rejects invalid input",
    "      tier: contract",
    "      type: automated",
    "      tdd_anchor: \"tests/parser.test.js\"",
    "      tdd_runner: \"node:test\"",
    "      fix_hint: \"Add focused parser rejection coverage\" # executor hint",
    "    - name: Error copy is actionable",
    "      tier: quality",
    "      type: evaluated",
  ].join("\n");

  const factors = extractAllFactors(rubric);

  assert.deepEqual(factors.map((factor) => ({
    name: factor.name,
    fix_hint: factor.fix_hint,
  })), [
    {
      name: "Parser rejects invalid input",
      fix_hint: "Add focused parser rejection coverage",
    },
    {
      name: "Error copy is actionable",
      fix_hint: null,
    },
  ]);
  assert.deepEqual(extractTddFactors(rubric), [
    {
      name: "Parser rejects invalid input",
      tdd_anchor: "tests/parser.test.js",
      tdd_runner: "node:test",
    },
  ]);
});

test("tdd_runner falls back to first probe test_infra entry", () => {
  const rubric = TDD_RUBRIC.replace("      tdd_runner: \"node:test\"\n", "");

  const factors = resolveTddFactors({
    rubricYaml: rubric,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.deepEqual(factors.map((factor) => factor.tdd_runner), ["node:test"]);
});

test("missing tdd_runner with no test infra fails loud before Step 0a", () => {
  const rubric = TDD_RUBRIC.replace("      tdd_runner: \"node:test\"\n", "");

  assert.throws(
    () => resolveTddFactors({
      rubricYaml: rubric,
      probeSignal: JSON.stringify({ test_infra: [], project_tools: { frameworks: [] } }),
    }),
    /omits tdd_runner.*zero test_infra/
  );
});

test("iteration protocol reference renders Step 0a only for TDD rubrics", () => {
  const protocolPath = path.join(__dirname, "..", "references", "iteration-protocol.md");
  const protocol = fs.readFileSync(protocolPath, "utf-8");

  const nonTdd = renderIterationProtocolForRubric({
    iterationProtocolText: protocol,
    rubricYaml: NON_TDD_RUBRIC,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });
  const tdd = renderIterationProtocolForRubric({
    iterationProtocolText: protocol,
    rubricYaml: TDD_RUBRIC,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.equal(nonTdd, protocol);
  assert.equal(hasTddAnchor(TDD_RUBRIC), true);
  assert.match(tdd, /0a\. TDD RED ANCHOR STEP/);
});

test("reference docs document the exact two-cell TDD state matrix and avoid top-level tdd_mode", () => {
  const iterationProtocol = fs.readFileSync(path.join(__dirname, "..", "references", "iteration-protocol.md"), "utf-8");
  const rubricGuide = fs.readFileSync(path.join(__dirname, "..", "references", "rubric-design-guide.md"), "utf-8");
  const reviewSchema = fs.readFileSync(path.join(__dirname, "..", "..", "relay-review", "scripts", "review-schema.js"), "utf-8");
  const matrix = [
    "| any factor has `tdd_anchor` | Behavior |",
    "|------|----------|",
    "| Yes  | Step 0a active for every anchor; reviewer TDD section active; prereq exclusion active for those paths; Step 4(a) relaxed for `tdd_anchor` factors only |",
    "| No   | Pre-#142 baseline; byte-identical prompts; reviewer prompt unchanged |",
  ].join("\n");

  assert.match(rubricGuide, /tdd_anchor: <path-string>/);
  assert.match(rubricGuide, /tdd_runner: <jest\|pytest\|mocha\|vitest\|\.\.\.>/);
  assert.ok(iterationProtocol.includes(matrix));
  assert.match(iterationProtocol, /Do not add a top-level `tdd_mode` field/);
  assert.doesNotMatch(reviewSchema, /tdd_anchor|tdd_runner|tdd_mode/);
});

function git(repoPath, ...args) {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function childTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function writeExecutionEvidence(runDir, headSha, overrides = {}) {
  const filePath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  fs.writeFileSync(filePath, `${JSON.stringify({
    schema_version: 1,
    head_sha: headSha,
    test_command: "node --test anchor.test.js non_tdd.test.js",
    test_result_hash: "unspecified",
    test_result_summary: "exit 0",
    recorded_at: "2026-04-22T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
    ...overrides,
  }, null, 2)}\n`, "utf-8");
  return filePath;
}

function setupMixedTddRepo(rubricContent) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mixed-tdd-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mixed-tdd-origin-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  git(repoRoot, "config", "user.name", "Relay Mixed TDD Test");
  git(repoRoot, "config", "user.email", "relay-mixed-tdd@example.com");
  fs.writeFileSync(path.join(repoRoot, "parser.js"), "exports.parse = () => false;\n", "utf-8");
  fs.writeFileSync(path.join(repoRoot, "non_tdd.test.js"), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "test('non-TDD factor stays under normal review', () => {",
    "  assert.equal(2 + 2, 4);",
    "});",
    "",
  ].join("\n"), "utf-8");
  git(repoRoot, "add", "parser.js", "non_tdd.test.js");
  git(repoRoot, "commit", "-m", "init");
  git(repoRoot, "remote", "add", "origin", remoteRoot);
  git(repoRoot, "push", "-u", "origin", "main");

  const branch = "issue-142-mixed-tdd";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  git(worktreePath, "config", "user.name", "Relay Mixed TDD Test");
  git(worktreePath, "config", "user.email", "relay-mixed-tdd@example.com");

  const runId = "issue-142-mixed-tdd-20260403010000000";
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 142,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest.git.pr_number = 123;
  manifest.git.head_sha = git(worktreePath, "rev-parse", "HEAD");
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  writeManifest(manifestPath, manifest);
  createEnforcementFixture({
    repoRoot,
    runId,
    manifestPath,
    state: "loaded",
    rubricContent,
  });
  manifest = readManifest(manifestPath).data;
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);

  return { repoRoot, worktreePath, manifestPath, runDir, runId, branch };
}

function runPrerequisiteWithAnchorExclusion(worktreePath, logPath, label) {
  const args = [
    "--test",
    "--test-skip-pattern=anchor\\.test\\.js",
    "anchor.test.js",
    "non_tdd.test.js",
  ];
  fs.appendFileSync(logPath, `${label}: node ${args.join(" ")}\n`, "utf-8");
  execFileSync("node", args, {
    cwd: worktreePath,
    encoding: "utf-8",
    env: childTestEnv(),
    stdio: "pipe",
  });
}

function writeFakeGh({ repoRoot, branch, headSha }) {
  const ghPath = path.join(repoRoot, "fake-gh-mixed-tdd.js");
  const statePath = path.join(repoRoot, "fake-gh-mixed-tdd-state.json");
  const logPath = path.join(repoRoot, "fake-gh-mixed-tdd.log");
  fs.writeFileSync(statePath, JSON.stringify({ state: "OPEN", mergeCommit: null }), "utf-8");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const args = process.argv.slice(2);
const repoRoot = ${JSON.stringify(repoRoot)};
const branch = ${JSON.stringify(branch)};
const statePath = ${JSON.stringify(statePath)};
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n", "utf-8");
function loadState() { return JSON.parse(fs.readFileSync(statePath, "utf-8")); }
function saveState(next) { fs.writeFileSync(statePath, JSON.stringify(next), "utf-8"); }
if (args[0] === "pr" && args[1] === "view") {
  const state = loadState();
  const jsonArg = args[args.indexOf("--json") + 1] || "";
  if (jsonArg === "headRefName") {
    process.stdout.write(JSON.stringify({ headRefName: branch }));
    process.exit(0);
  }
  if (jsonArg === "comments,commits,mergeable,statusCheckRollup") {
    process.stdout.write(JSON.stringify({
      comments: [{ body: "<!-- relay-review -->\\n## Relay Review\\nVerdict: PASS\\nRounds: 1", createdAt: ${JSON.stringify(REVIEW_COMMENT_DATE)} }],
      commits: [{ oid: ${JSON.stringify(headSha)}, committedDate: ${JSON.stringify(REVIEW_COMMENT_DATE)} }],
      mergeable: "MERGEABLE",
      statusCheckRollup: []
    }));
    process.exit(0);
  }
  if (jsonArg === "state,mergeCommit") {
    process.stdout.write(JSON.stringify({ state: state.state, mergeCommit: state.mergeCommit }));
    process.exit(0);
  }
}
if (args[0] === "pr" && args[1] === "merge") {
  execFileSync("git", ["-C", repoRoot, "checkout", "main"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoRoot, "merge", "--squash", branch], { stdio: "pipe" });
  execFileSync("git", ["-C", repoRoot, "commit", "-m", "Squash mixed TDD branch"], { stdio: "pipe" });
  const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();
  saveState({ state: "MERGED", mergeCommit: { oid: sha } });
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "close") process.exit(0);
process.exit(0);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return { ghPath, logPath };
}

test("mixed TDD rubric drives red to green to reviewer pass and squash finalize", () => {
  const rubric = [
    "rubric:",
    "  prerequisites:",
    "    - command: \"node --test --test-skip-pattern=anchor\\\\.test\\\\.js anchor.test.js non_tdd.test.js\"",
    "      target: \"exit 0\"",
    "    - command: \"node --test --test-skip-pattern=anchor\\\\.test\\\\.js anchor.test.js non_tdd.test.js\"",
    "      target: \"exit 0\"",
    "  factors:",
    "    - name: Parser accepts valid input",
    "      tier: contract",
    "      type: automated",
    "      command: \"node --test anchor.test.js\"",
    "      target: \"exit 0\"",
    "      tdd_anchor: \"anchor.test.js\"",
    "      tdd_runner: \"node:test\"",
    "    - name: Non-TDD regression remains normal",
    "      tier: contract",
    "      type: automated",
    "      command: \"node --test non_tdd.test.js\"",
    "      target: \"exit 0\"",
  ].join("\n");
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");
  const renderedPrompt = applyTddFlavorToDispatchPrompt({
    dispatchPrompt: baseline,
    rubricYaml: rubric,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });
  const fixture = setupMixedTddRepo(rubric);
  const prerequisiteLog = path.join(fixture.repoRoot, "prerequisite-exclusion.log");

  assert.match(renderedPrompt, /0a\. TDD RED ANCHOR STEP/);
  assert.match(renderedPrompt, /Do not modify `rubric\.factors\[\]\.command`/);

  fs.writeFileSync(path.join(fixture.worktreePath, "anchor.test.js"), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { parse } = require('./parser');",
    "test('anchor.test.js parser accepts valid input', () => {",
    "  assert.equal(parse('valid'), true);",
    "});",
    "",
  ].join("\n"), "utf-8");
  git(fixture.worktreePath, "add", "anchor.test.js");
  git(fixture.worktreePath, "commit", "-m", `${TDD_COMMIT_PREFIX}add parser anchor`);

  for (const label of ["prerequisite-1", "prerequisite-2"]) {
    runPrerequisiteWithAnchorExclusion(fixture.worktreePath, prerequisiteLog, label);
  }
  const redResult = spawnSync("node", ["--test", "anchor.test.js"], {
    cwd: fixture.worktreePath,
    encoding: "utf-8",
    env: childTestEnv(),
    stdio: "pipe",
  });
  assert.notEqual(redResult.status, 0, redResult.stdout + redResult.stderr);

  fs.writeFileSync(path.join(fixture.worktreePath, "parser.js"), "exports.parse = () => true;\n", "utf-8");
  git(fixture.worktreePath, "add", "parser.js");
  git(fixture.worktreePath, "commit", "-m", "Implement parser behavior");
  execFileSync("node", ["--test", "anchor.test.js"], { cwd: fixture.worktreePath, encoding: "utf-8", env: childTestEnv(), stdio: "pipe" });
  execFileSync("node", ["--test", "non_tdd.test.js"], { cwd: fixture.worktreePath, encoding: "utf-8", env: childTestEnv(), stdio: "pipe" });
  git(fixture.worktreePath, "push", "-u", "origin", fixture.branch);

  const headSha = git(fixture.worktreePath, "rev-parse", "HEAD");
  const manifest = readManifest(fixture.manifestPath).data;
  manifest.git.head_sha = headSha;
  writeManifest(fixture.manifestPath, manifest);
  writeExecutionEvidence(fixture.runDir, headSha);
  const doneCriteriaPath = path.join(fixture.repoRoot, "done-criteria.md");
  const diffPath = path.join(fixture.repoRoot, "pr.diff");
  const reviewFile = path.join(fixture.repoRoot, "review-pass.json");
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Mixed TDD rubric must pass at HEAD.\n", "utf-8");
  fs.writeFileSync(diffPath, git(fixture.repoRoot, "diff", "main...issue-142-mixed-tdd"), "utf-8");
  fs.writeFileSync(reviewFile, `${JSON.stringify({
    verdict: "pass",
    summary: "Mixed TDD and non-TDD factors pass at HEAD.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [
      {
        factor: "Parser accepts valid input",
        target: "exit 0",
        observed: "red verified before parser implementation; green at HEAD",
        status: "pass",
        tier: "contract",
        notes: "TDD anchor is satisfied at HEAD.",
      },
      {
        factor: "Non-TDD regression remains normal",
        target: "exit 0",
        observed: "node --test non_tdd.test.js exits 0",
        status: "pass",
        tier: "contract",
        notes: "Reviewed under the normal non-TDD factor contract; no TDD relaxation applied.",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  }, null, 2)}\n`, "utf-8");

  const reviewResult = JSON.parse(execFileSync("node", [
    REVIEW_RUNNER_SCRIPT,
    "--repo", fixture.repoRoot,
    "--run-id", fixture.runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }));
  const promptText = fs.readFileSync(path.join(fixture.runDir, "review-round-1-prompt.md"), "utf-8");
  const appliedVerdict = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "review-round-1-verdict.json"), "utf-8"));
  const scoreEvent = readRunEvents(fixture.repoRoot, fixture.runId).find((event) => event.event === "iteration_score");

  assert.equal(reviewResult.state, STATES.READY_TO_MERGE);
  assert.deepEqual(scoreEvent.scores.map((score) => score.factor), [
    "Parser accepts valid input",
    "Non-TDD regression remains normal",
  ]);
  assert.match(promptText, /regex `\^\\s\*tdd_anchor:\\s\*\\S\+`/);
  assert.match(promptText, /Review non-TDD factors in the same rubric exactly as usual/);
  assert.match(appliedVerdict.rubric_scores[1].notes, /normal non-TDD factor contract/);

  const prereqLog = fs.readFileSync(prerequisiteLog, "utf-8").trim().split(/\r?\n/);
  assert.equal(prereqLog.length, 2);
  assert.ok(prereqLog.every((line) => line.includes("--test-skip-pattern=anchor\\.test\\.js")));

  const baseBefore = Number(git(fixture.repoRoot, "rev-list", "--count", "main"));
  const { ghPath, logPath } = writeFakeGh({ repoRoot: fixture.repoRoot, branch: fixture.branch, headSha });
  const finalizeResult = JSON.parse(execFileSync("node", [
    FINALIZE_RUN_SCRIPT,
    "--repo", fixture.repoRoot,
    "--run-id", fixture.runId,
    "--pr", "123",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: ghPath },
  }));
  const baseAfter = Number(git(fixture.repoRoot, "rev-list", "--count", "main"));
  const lastSubject = git(fixture.repoRoot, "log", "-1", "--pretty=%s", "main");
  const ghLog = fs.readFileSync(logPath, "utf-8");

  assert.equal(finalizeResult.state, STATES.MERGED);
  assert.equal(baseAfter, baseBefore + 1);
  assert.equal(lastSubject, "Squash mixed TDD branch");
  assert.doesNotMatch(lastSubject, /^tdd: red — /);
  assert.match(ghLog, /pr merge 123 --squash/);
});
