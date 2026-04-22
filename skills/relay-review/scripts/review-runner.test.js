const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  getRunsDir,
  updateManifestState,
  writeManifest,
  readManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");
const { readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
const {
  DEFAULT_ENFORCEMENT_RUBRIC,
  createGrandfatheredRubricAnchor,
  createEnforcementFixture,
} = require("../../relay-dispatch/scripts/test-support");
const {
  EXECUTION_EVIDENCE_FILENAME,
  FORCE_FINALIZE_GUIDANCE,
} = require("./review-runner/execution-evidence");

const SCRIPT = path.join(__dirname, "review-runner.js");
const DISPATCH_SCRIPT = path.join(__dirname, "../../relay-dispatch/scripts/dispatch.js");
const REVIEW_RUNNER_LINE_CAP = 420;
const REVIEW_RUNNER_FUNCTION_CAP = 12;

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-runner-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-origin-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const runId = "issue-42-20260403010000000";
  const worktreePath = path.join(repoRoot, "wt", "issue-42");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", "issue-42"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(worktreePath, "marker.txt"), "worktree\n", "utf-8");

  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-42",
    baseBranch: "main",
    issueNumber: 42,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor = createEnforcementFixture({
    repoRoot,
    runId,
    state: "loaded",
    rubricContent: DEFAULT_ENFORCEMENT_RUBRIC,
  }).anchor;
  manifest = {
    ...manifest,
    git: {
      ...(manifest.git || {}),
      pr_number: 123,
      head_sha: execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim(),
    },
  };
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);
  writeExecutionEvidence(runDir, manifest.git.head_sha);

  const doneCriteriaPath = path.join(repoRoot, "done-criteria.md");
  const diffPath = path.join(repoRoot, "pr.diff");
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Add smoke.txt\n- Do not touch auth\n", "utf-8");
  fs.writeFileSync(diffPath, "diff --git a/smoke.txt b/smoke.txt\n+ok\n", "utf-8");

  return { repoRoot, worktreePath, manifestPath, runId, doneCriteriaPath, diffPath };
}

function buildExecutionEvidence(headSha, overrides = {}) {
  return {
    schema_version: 1,
    head_sha: headSha,
    test_command: "unspecified",
    test_result_hash: "unspecified",
    test_result_summary: "unspecified",
    recorded_at: "2026-04-22T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
    ...overrides,
  };
}

function writeExecutionEvidence(runDir, headSha, overrides = {}) {
  const filePath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  fs.writeFileSync(filePath, `${JSON.stringify(buildExecutionEvidence(headSha, overrides), null, 2)}\n`, "utf-8");
  return filePath;
}

function createUnrelatedRelayOwnedWorktree(repoRoot, branch = "issue-42") {
  const attackerParent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-foreign-"));
  const attackerRoot = path.join(attackerParent, path.basename(repoRoot));
  fs.mkdirSync(attackerRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Foreign"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review-foreign@example.com"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(attackerRoot, "README.md"), "foreign\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  const relayWorktrees = path.join(process.env.RELAY_HOME, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const attackerWorktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "foreign-"));
  const attackerWorktree = path.join(attackerWorktreeParent, path.basename(repoRoot));
  execFileSync("git", ["worktree", "add", attackerWorktree, "-b", branch], {
    cwd: attackerRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(attackerWorktree, "sentinel.txt"), "foreign\n", "utf-8");
  return { attackerRoot, attackerWorktree };
}

function createUnrelatedGitRepo(prefix = "relay-review-manifest-cwd-") {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Manifest"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review-manifest@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "manifest selector\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return repoRoot;
}

function setReviewPending(manifestPath) {
  const { data, body } = readManifest(manifestPath);
  let updated = data;
  if (updated.state === STATES.CHANGES_REQUESTED) {
    updated = updateManifestState(updated, STATES.DISPATCHED, "await_dispatch_result");
    updated = updateManifestState(updated, STATES.REVIEW_PENDING, "run_review");
  }
  writeManifest(manifestPath, updated, body);
}

function updateManifestRecord(manifestPath, updater) {
  const { data, body } = readManifest(manifestPath);
  const updated = updater(data);
  writeManifest(manifestPath, updated, body);
  return updated;
}

function configureRubricFixture({ manifestPath, repoRoot, runId, state }) {
  return createEnforcementFixture({
    repoRoot,
    runId,
    manifestPath,
    state,
    rubricContent: "rubric:\n  factors:\n    - name: API pagination\n      target: \">= 8/10\"\n",
  }).runDir;
}

function writeVerdict(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  fs.writeFileSync(filePath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
  return filePath;
}

function writePassVerdict(repoRoot, name = "pass.json") {
  return writeVerdict(repoRoot, name, {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });
}

function defaultRubricScores() {
  return [
    {
      factor: "Default enforcement rubric",
      target: ">= 1/1",
      observed: "1/1",
      status: "pass",
      tier: "contract",
      notes: "The enforcement fixture rubric remained satisfied.",
    },
  ];
}

function prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath }) {
  return JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" }));
}

function runPassReview({
  repoRoot,
  runId,
  doneCriteriaPath,
  diffPath,
  reviewFile,
  env,
  noComment = true,
}) {
  const args = [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
  ];
  if (noComment) {
    args.push("--no-comment");
  }
  args.push("--json");
  return JSON.parse(execFileSync("node", args, {
    encoding: "utf-8",
    env,
  }));
}

function writeReviewerScript(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  const body = `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
`;
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeMutatingReviewerScript(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  const body = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const repo = repoIndex !== -1 ? args[repoIndex + 1] : process.cwd();
fs.writeFileSync(path.join(repo, "reviewer-mutated.txt"), "bad\\n", "utf-8");
process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
`;
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function runReviewRunnerModule(lines) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-module-"));
  const helperPath = path.join(tmpDir, "helper.js");
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const reviewRunner = require(${JSON.stringify(SCRIPT)});`,
    ...lines,
  ].join("\n"), "utf-8");
  return execFileSync("node", [helperPath], { encoding: "utf-8" });
}

function countFileLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function writeFakeGhScript(repoRoot, { prBody, capturePath }) {
  const filePath = path.join(repoRoot, "gh");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ body: ${JSON.stringify(prBody)} }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "comment") {
  const bodyIndex = args.indexOf("--body");
  const body = bodyIndex !== -1 ? args[bodyIndex + 1] : "";
  fs.writeFileSync(${JSON.stringify(capturePath)}, body, "utf-8");
  process.exit(0);
}
process.stderr.write("Unsupported gh invocation: " + args.join(" "));
process.exit(1);
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeManifestOnlyGhScript(binDir, { trustedRepoRoot, capturePath, issueBody, diffText, prBody }) {
  const filePath = path.join(binDir, "gh");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cwd = fs.realpathSync(process.cwd());
const trustedRepoRoot = ${JSON.stringify(fs.realpathSync(trustedRepoRoot))};
const capturePath = ${JSON.stringify(capturePath)};
const issueBody = ${JSON.stringify(issueBody)};
const diffText = ${JSON.stringify(diffText)};
const prBody = ${JSON.stringify(prBody)};
const args = process.argv.slice(2);

if (cwd !== trustedRepoRoot) {
  process.stderr.write("gh invoked from unexpected cwd: " + cwd);
  process.exit(19);
}

if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ number: 123 }]));
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    number: 42,
    title: "Manifest-selected issue",
    body: issueBody,
  }));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write(diffText);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const jsonIndex = args.indexOf("--json");
  const fields = jsonIndex === -1 ? "" : args[jsonIndex + 1];
  if (fields === "closingIssuesReferences,body,headRefName") {
    process.stdout.write(JSON.stringify({
      closingIssuesReferences: [{ number: 42 }],
      body: prBody,
      headRefName: "issue-42",
    }));
    process.exit(0);
  }
  if (fields === "body") {
    process.stdout.write(JSON.stringify({ body: prBody }));
    process.exit(0);
  }
  if (fields === "title,body,number") {
    process.stdout.write(JSON.stringify({
      number: 123,
      title: "Manifest-selected PR",
      body: prBody,
    }));
    process.exit(0);
  }
}

if (args[0] === "pr" && args[1] === "comment") {
  const bodyIndex = args.indexOf("--body");
  const body = bodyIndex !== -1 ? args[bodyIndex + 1] : "";
  fs.writeFileSync(capturePath, body, "utf-8");
  process.exit(0);
}

process.stderr.write("Unsupported gh invocation: " + args.join(" "));
process.exit(1);
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeFakeCodex(binDir) {
  const ghPath = path.join(binDir, "gh");
  if (!fs.existsSync(ghPath)) {
    fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://example.test/acme/dev-relay/pull/123\\n");
  process.exit(0);
}
process.stderr.write("Unsupported gh invocation: " + args.join(" "));
process.exit(1);
`, "utf-8");
    fs.chmodSync(ghPath, 0o755);
  }
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
const fileName = fs.existsSync(cwd + "/first.txt") ? "resume.txt" : "first.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
fs.writeFileSync(output, "ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

test("prepare-only writes a prompt bundle without changing manifest state", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.prepareOnly, true);
  assert.equal(result.round, 1);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(path.basename(result.promptPath), "review-round-1-prompt.md");
  assert.ok(fs.existsSync(result.promptPath));
  assert.ok(fs.existsSync(result.doneCriteriaPath));
  assert.ok(fs.existsSync(result.diffPath));
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
  assert.equal(readManifest(manifestPath).data.run_id, runId);
});

test("review-runner facade stays within orchestrator caps and preserves CLI help", () => {
  const source = fs.readFileSync(SCRIPT, "utf-8");
  const lineCount = countFileLines(source);
  const topLevelFunctions = (source.match(/^(?:async )?function\s+\w+/gm) || []).length;

  assert.ok(
    lineCount <= REVIEW_RUNNER_LINE_CAP,
    `review-runner.js must stay <= ${REVIEW_RUNNER_LINE_CAP} lines (got ${lineCount})`
  );
  assert.ok(
    topLevelFunctions <= REVIEW_RUNNER_FUNCTION_CAP,
    `review-runner.js must stay <= ${REVIEW_RUNNER_FUNCTION_CAP} top-level functions (got ${topLevelFunctions})`
  );

  const help = spawnSync("node", [SCRIPT, "--help"], { encoding: "utf-8" });
  assert.equal(help.status, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /Usage: review-runner\.js --repo <path>/);
  assert.match(help.stdout, /--prepare-only/);
  assert.match(help.stdout, /--reviewer-script <path>/);
});

test("prepare-only loads frozen Done Criteria from manifest anchor before GitHub fallbacks", () => {
  const { repoRoot, manifestPath, runId, diffPath } = setupRepo();
  const anchoredDoneCriteriaPath = path.join(repoRoot, "frozen-done-criteria.md");
  fs.writeFileSync(anchoredDoneCriteriaPath, "# Frozen Done Criteria\n\n- Use the persisted intake snapshot\n", "utf-8");

  const record = readManifest(manifestPath);
  const updated = {
    ...record.data,
    anchor: {
      ...(record.data.anchor || {}),
      done_criteria_path: anchoredDoneCriteriaPath,
      done_criteria_source: "request_snapshot",
    },
  };
  writeManifest(manifestPath, updated, record.body);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  const doneCriteriaText = fs.readFileSync(result.doneCriteriaPath, "utf-8");
  assert.match(promptText, /source="request_snapshot"/);
  assert.match(doneCriteriaText, /Use the persisted intake snapshot/);
});

test("missing manifest-anchored Done Criteria fails loudly without fallback", () => {
  const { repoRoot, manifestPath, runId, diffPath } = setupRepo();
  const missingDoneCriteriaPath = path.join(repoRoot, "missing-frozen-done-criteria.md");

  const record = readManifest(manifestPath);
  const updated = {
    ...record.data,
    anchor: {
      ...(record.data.anchor || {}),
      done_criteria_path: missingDoneCriteriaPath,
      done_criteria_source: "request_snapshot",
    },
  };
  writeManifest(manifestPath, updated, record.body);

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), (error) => {
    assert.match(String(error.stderr), /Manifest anchor\.done_criteria_path points to a missing file/);
    return true;
  });
});

test("pass verdict moves review_pending to ready_to_merge", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "pass.json", {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.commentPosted, false);
  assert.ok(fs.existsSync(result.verdictPath));

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.next_action, "await_explicit_merge");
  assert.equal(manifest.git.pr_number, 123);
  assert.equal(manifest.review.rounds, 1);
  assert.equal(manifest.review.latest_verdict, "lgtm");
  assert.ok(manifest.review.last_reviewed_sha);
  assert.equal(manifest.review.last_contract_status, "pass");
  assert.equal(manifest.review.last_quality_review_status, "pass");
  assert.equal(manifest.review.last_quality_execution_status, "pass");
  assert.equal(manifest.review.last_quality_execution_reason, null);
});

test("pass verdict preserves assigned reviewer role and records the acting reviewer separately", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writePassVerdict(repoRoot);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--reviewer", "codex",
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  const manifest = readManifest(manifestPath).data;
  const events = readRunEvents(repoRoot, runId);
  const reviewApplyEvent = [...events].reverse().find((event) => event.event === "review_apply");
  assert.equal(result.reviewer, "codex");
  assert.equal(manifest.roles.reviewer, "claude");
  assert.equal(manifest.review.last_reviewer, "codex");
  assert.equal(reviewApplyEvent?.reviewer, "codex");
});

test("pass verdict rejects quality_review_status=not_run", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "phase1-pass.json", {
    verdict: "pass",
    summary: "No blocking review issues found.",
    contract_status: "pass",
    quality_review_status: "not_run",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), (error) => {
    assert.match(String(error.stderr), /PASS verdict failed: quality_review_status=not_run/);
    return true;
  });

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.review.latest_verdict, "pending");
});

test("review-runner fail-closes reviewer PASS into changes_requested when execution evidence is absent", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  const commentCapturePath = path.join(repoRoot, "missing-execution-comment.txt");
  fs.unlinkSync(path.join(runDir, EXECUTION_EVIDENCE_FILENAME));
  writeFakeGhScript(repoRoot, {
    capturePath: commentCapturePath,
    prBody: "",
  });

  const reviewFile = writeVerdict(repoRoot, "forged-execution-pass.json", {
    verdict: "pass",
    summary: "Inspection passed.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  const result = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${repoRoot}:${process.env.PATH}`,
    },
  }));
  const verdictRecord = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));
  const commentBody = fs.readFileSync(commentCapturePath, "utf-8");

  const manifest = readManifest(manifestPath).data;
  const reviewApplyEvent = readRunEvents(repoRoot, runId).find((event) => event.event === "review_apply");

  assert.equal(result.appliedVerdict, "changes_requested");
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.equal(verdictRecord.verdict, "changes_requested");
  assert.equal(verdictRecord.quality_execution_status, "missing");
  assert.match(verdictRecord.summary, /fail-closed reviewer PASS/);
  assert.equal(verdictRecord.issues[0].file, EXECUTION_EVIDENCE_FILENAME);
  assert.match(verdictRecord.issues[0].body, new RegExp(FORCE_FINALIZE_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(manifest.state, STATES.CHANGES_REQUESTED);
  assert.equal(manifest.review.latest_verdict, "changes_requested");
  assert.equal(manifest.review.last_quality_execution_status, "missing");
  assert.match(commentBody, /Verdict: CHANGES_REQUESTED/);
  assert.match(commentBody, /Quality Execution: MISSING/);
  assert.match(commentBody, new RegExp(FORCE_FINALIZE_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(reviewApplyEvent?.reason, "changes_requested");
});

test("review-runner stores the runner-computed quality_execution_status in the verdict file, comment, and manifest", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  const commentCapturePath = path.join(repoRoot, "execution-status-comment.txt");
  fs.unlinkSync(path.join(runDir, EXECUTION_EVIDENCE_FILENAME));
  writeFakeGhScript(repoRoot, {
    capturePath: commentCapturePath,
    prBody: "",
  });

  const reviewFile = writeVerdict(repoRoot, "changes-with-forged-execution.json", {
    verdict: "changes_requested",
    summary: "Contract drift found.",
    contract_status: "fail",
    quality_review_status: "not_run",
    quality_execution_status: "pass",
    next_action: "changes_requested",
    issues: [{
      title: "Missing contract item",
      body: "smoke.txt is not present in the diff.",
      file: "src/index.js",
      line: 10,
      category: "contract",
      severity: "high",
    }],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  const result = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${repoRoot}:${process.env.PATH}`,
    },
  }));

  const verdictRecord = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));
  const manifest = readManifest(manifestPath).data;
  const commentBody = fs.readFileSync(commentCapturePath, "utf-8");

  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.equal(verdictRecord.quality_execution_status, "missing");
  assert.match(verdictRecord.quality_execution_reason, /pre-261 run, no artifact/);
  assert.equal(manifest.review.last_quality_execution_status, "missing");
  assert.match(manifest.review.last_quality_execution_reason, /pre-261 run, no artifact/);
  assert.match(commentBody, /Quality Execution: MISSING/);
});

test("review-runner rejects invalid manifest run_id before creating a sibling run directory", () => {
  const { repoRoot, manifestPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  const victimRunDir = path.resolve(getRunsDir(repoRoot), "../victim-review-run");

  writeManifest(manifestPath, {
    ...record.data,
    run_id: "../victim-review-run",
  }, record.body);

  assert.equal(fs.existsSync(victimRunDir), false);
  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--manifest", manifestPath,
    "--pr", "123",
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), (error) => {
    assert.match(String(error.stderr), /run_id must be a single path segment/);
    return true;
  });
  assert.equal(fs.existsSync(victimRunDir), false);
});

test("review-runner can prepare from --manifest when --repo points at an unrelated git repo", () => {
  const { repoRoot, manifestPath, runId, worktreePath, doneCriteriaPath, diffPath } = setupRepo();
  const selectorRepo = createUnrelatedGitRepo();

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", selectorRepo,
    "--manifest", manifestPath,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" });

  const result = JSON.parse(stdout);
  const canonicalRunDir = path.join(getRunsDir(repoRoot), runId);
  assert.equal(result.prepareOnly, true);
  assert.ok(result.promptPath.startsWith(canonicalRunDir));
  assert.ok(result.diffPath.startsWith(canonicalRunDir));
  assert.equal(result.reviewRepoPath, worktreePath);
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
});

test("review-runner manifest-only rounds keep gh-backed reads and comments on the validated repo root", () => {
  const { repoRoot, manifestPath, runId } = setupRepo();
  const selectorRepo = createUnrelatedGitRepo();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-gh-"));
  const commentCapturePath = path.join(repoRoot, "manifest-only-comment.txt");
  const reviewFile = writePassVerdict(repoRoot, "manifest-only-pass.json");
  writeManifestOnlyGhScript(fakeBin, {
    trustedRepoRoot: repoRoot,
    capturePath: commentCapturePath,
    issueBody: "## Done Criteria\n\n- Keep gh operations bound to the manifest repo\n",
    diffText: "diff --git a/smoke.txt b/smoke.txt\n+ok\n",
    prBody: [
      "## Score Log",
      "",
      "| Factor | Target | Baseline | Iter 1 | Final | Status |",
      "|--------|--------|----------|--------|-------|--------|",
      "| Coverage | >= 8 | — | 9 | 9 | locked |",
    ].join("\n"),
  });

  updateManifestRecord(manifestPath, (data) => ({
    ...data,
    issue: {},
    git: {
      ...(data.git || {}),
      pr_number: null,
    },
  }));

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", selectorRepo,
    "--manifest", manifestPath,
    "--review-file", reviewFile,
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  });

  const result = JSON.parse(stdout);
  const manifest = readManifest(manifestPath).data;
  assert.equal(result.prNumber, 123);
  assert.equal(result.issueNumber, 42);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.commentPosted, true);
  assert.match(fs.readFileSync(commentCapturePath, "utf-8"), /LGTM/);
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.git.pr_number, 123);
  assert.equal(manifest.review.latest_verdict, "lgtm");
});

test("review-runner rejects relay-base same-name worktrees before preparing prompts in an unrelated checkout", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const { attackerWorktree } = createUnrelatedRelayOwnedWorktree(repoRoot);
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      worktree: attackerWorktree,
    },
  }, record.body);

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), (error) => {
    assert.match(String(error.stderr), /manifest paths\.worktree/);
    return true;
  });

  assert.equal(fs.existsSync(path.join(attackerWorktree, "review-round-1-prompt.md")), false);
  assert.equal(fs.existsSync(path.join(attackerWorktree, "sentinel.txt")), true);
});

test("review-runner rejects tampered paths.repo_root before prepare-only prompt side effects", () => {
  const { repoRoot, worktreePath, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const { attackerRoot } = createUnrelatedRelayOwnedWorktree(repoRoot);
  const record = readManifest(manifestPath);
  const runDir = getRunsDir(repoRoot);
  const actualPromptPath = path.join(runDir, runId, "review-round-1-prompt.md");
  const actualDiffPath = path.join(runDir, runId, "review-round-1-diff.patch");
  const attackerRunDir = path.join(getRunsDir(attackerRoot), runId);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      repo_root: attackerRoot,
    },
  }, record.body);

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest paths\.repo_root/);
  assert.equal(fs.existsSync(actualPromptPath), false, "prepare-only must reject before writing the prompt bundle");
  assert.equal(fs.existsSync(actualDiffPath), false, "prepare-only must reject before writing the diff bundle");
  assert.equal(fs.existsSync(attackerRunDir), false, "prepare-only must not create a run dir under the tampered repo_root");
  assert.equal(fs.existsSync(worktreePath), true, "prepare-only must reject before touching the retained checkout");
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
});

test("review-runner fails closed when branch+PR resolution only finds a stale terminal manifest", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  const staleManifest = {
    ...updateManifestState(
      updateManifestState(record.data, STATES.READY_TO_MERGE, "await_explicit_merge"),
      STATES.MERGED,
      "manual_cleanup_required"
    ),
    git: {
      ...(record.data.git || {}),
      pr_number: null,
    },
  };
  writeManifest(manifestPath, staleManifest, record.body);

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), (error) => {
    assert.match(String(error.stderr), /Only terminal branch matches exist/);
    assert.match(String(error.stderr), /Create a fresh dispatch for this branch before retrying/);
    return true;
  });
});

test("changes_requested verdict creates a re-dispatch artifact", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "changes.json", {
    verdict: "changes_requested",
    summary: "One requirement is missing.",
    contract_status: "fail",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "changes_requested",
    issues: [
      {
        title: "Missing smoke file",
        body: "The PR does not add the required smoke.txt output.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.ok(result.redispatchPath);
  assert.ok(fs.existsSync(result.redispatchPath));
  const redispatchText = fs.readFileSync(result.redispatchPath, "utf-8");
  assert.match(redispatchText, /Fix these review issues in the PR/);
  assert.match(redispatchText, /src\/index.js:12/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CHANGES_REQUESTED);
  assert.equal(manifest.next_action, "re_dispatch_requested_changes");
  assert.equal(manifest.review.rounds, 1);
  assert.equal(manifest.review.latest_verdict, "changes_requested");
  assert.equal(manifest.review.repeated_issue_count, 1);
});

test("review-runner records rubric_scores as iteration_score events", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "changes-with-scores.json", {
    verdict: "changes_requested",
    summary: "Coverage and docs still need work.",
    contract_status: "fail",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "changes_requested",
    issues: [
      {
        title: "Missing smoke file",
        body: "The PR does not add the required smoke.txt output.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: [
      {
        factor: "Coverage",
        target: ">= 8",
        observed: "6",
        status: "fail",
        tier: "contract",
        notes: "Still below bar.",
      },
      {
        factor: "Docs",
        target: ">= 8",
        observed: "8",
        status: "pass",
        tier: "quality",
        notes: "Docs are complete.",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const events = readRunEvents(repoRoot, runId);
  assert.equal(events.at(-2).event, "review_apply");
  assert.equal(events.at(-1).event, "iteration_score");
  assert.deepEqual(events.at(-1), {
    ts: events.at(-1).ts,
    event: "iteration_score",
    actor: "Relay Review Test",
    run_id: runId,
    round: 1,
    scores: [
      {
        factor: "Coverage",
        target: ">= 8",
        observed: "6",
        met: false,
        status: "fail",
        tier: "contract",
      },
      {
        factor: "Docs",
        target: ">= 8",
        observed: "8",
        met: true,
        status: "pass",
        tier: "quality",
      },
    ],
  });
  assert.match(events.at(-1).ts, /\d{4}-\d{2}-\d{2}T/);
});

test("review-runner records score divergence and appends warning text to the PR comment", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo();
  const commentCapturePath = path.join(repoRoot, "captured-comment.txt");
  writeFakeGhScript(repoRoot, {
    capturePath: commentCapturePath,
    prBody: [
      "## Score Log",
      "",
      "| Factor | Target | Baseline | Iter 1 | Final | Status |",
      "|--------|--------|----------|--------|-------|--------|",
      "| Coverage | >= 8 | — | 9 | 9 | locked |",
      "| Docs & Notes? | >= 8 | — | 8 | — | locked |",
      "| Placeholder | >= 8 | — | n/a | — | — |",
    ].join("\n"),
  });
  const reviewFile = writeVerdict(repoRoot, "changes-with-divergence.json", {
    verdict: "changes_requested",
    summary: "Scores disagree on implementation quality.",
    contract_status: "fail",
    quality_review_status: "fail",
    next_action: "changes_requested",
    issues: [
      {
        title: "Missing smoke file",
        body: "The PR does not add the required smoke.txt output.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: [
      {
        factor: "Coverage",
        target: ">= 8",
        observed: "6",
        status: "fail",
        notes: "Still below bar.",
        tier: "contract",
      },
      {
        factor: "Docs & Notes?",
        target: ">= 8",
        observed: "7",
        status: "fail",
        notes: "Clarity still needs work.",
        tier: "quality",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${repoRoot}:${process.env.PATH}`,
    },
  });

  const events = readRunEvents(repoRoot, runId);
  assert.equal(events.at(-2).event, "iteration_score");
  assert.equal(events.at(-1).event, "score_divergence");
  assert.deepEqual(events.at(-1).divergences, [
    {
      factor: "Coverage",
      executor: "9",
      reviewer: "6",
      delta: 3,
      tier: "contract",
    },
    {
      factor: "Docs & Notes?",
      executor: "8",
      reviewer: "7",
      delta: 1,
      tier: "quality",
    },
  ]);

  const commentBody = fs.readFileSync(commentCapturePath, "utf-8");
  assert.match(commentBody, /Score divergence warnings:/);
  assert.match(commentBody, /Coverage: executor 9, reviewer 6 \(\+3\)/);
  assert.doesNotMatch(commentBody, /Docs & Notes\?: executor 8, reviewer 7/);
});

test("review-runner keeps event journals on the manifest repo slug when --repo is a symlinked alias", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const repoAliasPath = `${repoRoot}-alias`;
  fs.symlinkSync(repoRoot, repoAliasPath, "dir");
  writeFakeGhScript(repoRoot, {
    capturePath: path.join(repoRoot, "unused-comment.txt"),
    prBody: [
      "## Score Log",
      "",
      "| Factor | Target | Baseline | Iter 1 | Final | Status |",
      "|--------|--------|----------|--------|-------|--------|",
      "| Coverage | >= 8 | — | 9 | 9 | locked |",
    ].join("\n"),
  });
  const reviewFile = writeVerdict(repoRoot, "changes-with-alias-divergence.json", {
    verdict: "changes_requested",
    summary: "Coverage still misses the bar.",
    contract_status: "fail",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "changes_requested",
    issues: [
      {
        title: "Missing smoke file",
        body: "The PR does not add the required smoke.txt output.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: [
      {
        factor: "Coverage",
        target: ">= 8",
        observed: "6",
        status: "fail",
        notes: "Still below bar.",
        tier: "contract",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoAliasPath,
    "--manifest", manifestPath,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${repoRoot}:${process.env.PATH}`,
    },
  });

  const result = JSON.parse(stdout);
  const canonicalRunDir = path.join(getRunsDir(repoRoot), runId);
  const aliasEventsPath = path.join(getRunsDir(repoAliasPath), runId, "events.jsonl");
  const events = readRunEvents(repoRoot, runId);

  assert.ok(result.verdictPath.startsWith(canonicalRunDir));
  assert.deepEqual(events.map((event) => event.event), [
    "review_apply",
    "iteration_score",
    "score_divergence",
  ]);
  assert.equal(events.at(-1).divergences[0].factor, "Coverage");
  assert.equal(fs.existsSync(aliasEventsPath), true);
  assert.deepEqual(readRunEvents(repoAliasPath, runId), events);
});

test("review-runner accepts a worktree --repo selector and still validates against the canonical repo root", () => {
  const { repoRoot, worktreePath, runId, doneCriteriaPath, diffPath } = setupRepo();

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", worktreePath,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  const result = JSON.parse(stdout);
  const expectedRunDir = ensureRunLayout(repoRoot, runId).runDir;
  assert.equal(result.branch, "issue-42");
  assert.equal(result.prNumber, 123);
  assert.equal(result.runId, runId);
  assert.equal(result.rubricLoaded, "loaded");
  assert.equal(result.reviewRepoPath, worktreePath);
  assert.equal(path.dirname(result.promptPath), expectedRunDir);
});

test("reviewer-script invocation can drive a round without --review-file", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewerScript = writeReviewerScript(repoRoot, "reviewer-pass.js", {
    verdict: "pass",
    summary: "Automated reviewer passed the change.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer-script", reviewerScript,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.reviewerScript, reviewerScript);
  assert.ok(result.rawResponsePath);
  assert.ok(fs.existsSync(result.rawResponsePath));

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.review.latest_verdict, "lgtm");
  assert.ok(manifest.review.last_reviewed_sha);
});

test("invalid pass verdict is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "invalid-pass.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [
      {
        title: "Should not be here",
        body: "PASS verdict cannot carry issues.",
        file: "x.js",
        line: 1,
        category: "contract",
        severity: "low",
      },
    ],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /PASS verdict must not include issues/);
});

test("invalid rubric score entry is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "invalid-rubric.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [
      {
        factor: "Contract coverage",
        target: ">= 8",
        observed: "9",
        status: "pass",
        tier: "contract",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /rubric_scores\[0\]\.notes is required/);
});

test("review-runner rejects rubric score without tier", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "invalid-rubric-tier.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [
      {
        factor: "Contract coverage",
        target: ">= 8",
        observed: "9",
        status: "pass",
        notes: "Matches the contract.",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /rubric_scores\[0\]\.tier is required/);
});

test("pass verdict with not_done scope_drift entry is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "pass-with-not-done.json", {
    verdict: "pass",
    summary: "All good.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: {
      creep: [],
      missing: [{ criteria: "Add smoke.txt", status: "not_done" }],
    },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /PASS verdict cannot have scope_drift\.missing entries with status not_done, changed, or partial/);
});

test("pass verdict with partial scope_drift entry is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "pass-with-partial.json", {
    verdict: "pass",
    summary: "Mostly done.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: {
      creep: [],
      missing: [{ criteria: "Add smoke.txt", status: "partial" }],
    },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /PASS verdict cannot have scope_drift\.missing entries with status not_done, changed, or partial/);
});

test("invalid scope_drift missing status is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "bad-drift-status.json", {
    verdict: "changes_requested",
    summary: "Missing requirement.",
    contract_status: "fail",
    quality_review_status: "not_run",
    next_action: "changes_requested",
    issues: [{ title: "Missing", body: "Not implemented", file: "x.js", line: 1, category: "contract", severity: "high" }],
    rubric_scores: defaultRubricScores(),
    scope_drift: {
      creep: [],
      missing: [{ criteria: "Add smoke.txt", status: "unknown" }],
    },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /scope_drift\.missing\[0\]\.status must be one of/);
});

test("changes_requested verdict with scope_drift includes drift in redispatch", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "drift-changes.json", {
    verdict: "changes_requested",
    summary: "Scope creep and missing requirement.",
    contract_status: "fail",
    quality_review_status: "not_run",
    next_action: "changes_requested",
    issues: [{ title: "Creep", body: "Unrelated change", file: "extra.js", line: 1, category: "scope", severity: "medium" }],
    rubric_scores: defaultRubricScores(),
    scope_drift: {
      creep: [{ file: "extra.js", reason: "Not in Done Criteria" }],
      missing: [
        { criteria: "Add smoke.txt", status: "not_done" },
        { criteria: "Update README", status: "verified" },
      ],
    },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.ok(result.redispatchPath);
  const redispatchText = fs.readFileSync(result.redispatchPath, "utf-8");
  assert.match(redispatchText, /Scope creep/);
  assert.match(redispatchText, /extra\.js: Not in Done Criteria/);
  assert.match(redispatchText, /\[NOT_DONE\] Add smoke\.txt/);
  assert.doesNotMatch(redispatchText, /Update README/);
});

test("reviewer write policy violation escalates the manifest", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewerScript = writeMutatingReviewerScript(repoRoot, "reviewer-mutates.js", {
    verdict: "pass",
    summary: "This should not be trusted.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer-script", reviewerScript,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /Reviewer write policy violation detected/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.next_action, "inspect_review_failure");
  assert.equal(manifest.review.rounds, 1);
  assert.equal(manifest.review.latest_verdict, "policy_violation");
  assert.ok(manifest.review.last_reviewed_sha);
});

test("reviewer runs against the retained worktree, not repo root", () => {
  const { repoRoot, worktreePath, manifestPath, doneCriteriaPath, diffPath, runId } = setupRepo();
  fs.writeFileSync(path.join(repoRoot, "marker.txt"), "repo-root\n", "utf-8");
  fs.writeFileSync(path.join(worktreePath, "marker.txt"), "retained-worktree\n", "utf-8");

  const reviewerScript = path.join(repoRoot, "reviewer-reads-marker.js");
  fs.writeFileSync(reviewerScript, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const repo = repoIndex !== -1 ? args[repoIndex + 1] : process.cwd();
const marker = fs.readFileSync(path.join(repo, "marker.txt"), "utf-8").trim();
process.stdout.write(JSON.stringify({
  verdict: marker === "retained-worktree" ? "pass" : "changes_requested",
  summary: marker === "retained-worktree" ? "Read retained checkout" : "Wrong checkout",
  contract_status: marker === "retained-worktree" ? "pass" : "fail",
  quality_review_status: "pass",
    quality_execution_status: "pass",
  next_action: marker === "retained-worktree" ? "ready_to_merge" : "changes_requested",
  issues: marker === "retained-worktree" ? [] : [{
    title: "Wrong checkout",
    body: marker,
    file: "marker.txt",
    line: 1,
    category: "contract",
    severity: "high"
  }],
  rubric_scores: ${JSON.stringify(defaultRubricScores())},
  scope_drift: { creep: [], missing: [] }
}));
`, "utf-8");
  fs.chmodSync(reviewerScript, 0o755);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer-script", reviewerScript,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.reviewRepoPath, worktreePath);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.review.latest_verdict, "lgtm");
});

test("review runner enforces max_rounds before starting a new round", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath, runId } = setupRepo();
  const { data, body } = readManifest(manifestPath);
  data.review.rounds = 1;
  data.review.max_rounds = 1;
  writeManifest(manifestPath, data, body);

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /Review round cap exceeded/);

  const manifest = readManifest(manifestPath).data;
  const events = readRunEvents(repoRoot, runId);
  const reviewApplyEvent = [...events].reverse().find((event) => event.event === "review_apply");
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.review.latest_verdict, "max_rounds_exceeded");
  assert.equal(reviewApplyEvent?.origin, "system");
  assert.equal(reviewApplyEvent?.state_to, STATES.ESCALATED);
  assert.equal("reviewer" in reviewApplyEvent, false);
});

test("repeated identical issues escalate on the third consecutive round", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath, runId } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "same-issue.json", {
    verdict: "changes_requested",
    summary: "Same issue persists.",
    contract_status: "fail",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "changes_requested",
    issues: [
      {
        title: "Still missing smoke file",
        body: "The PR still does not add smoke.txt.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  for (let round = 1; round <= 3; round += 1) {
    const stdout = execFileSync("node", [
      SCRIPT,
      "--repo", repoRoot,
      "--run-id", runId,
      "--pr", "123",
      "--done-criteria-file", doneCriteriaPath,
      "--diff-file", diffPath,
      "--review-file", reviewFile,
      "--no-comment",
      "--json",
    ], { encoding: "utf-8" });
    const result = JSON.parse(stdout);
    if (round < 3) {
      assert.equal(result.state, STATES.CHANGES_REQUESTED);
      setReviewPending(manifestPath);
    } else {
      assert.equal(result.state, STATES.ESCALATED);
      assert.equal(result.repeatedIssueCount, 3);
    }
  }

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.review.latest_verdict, "escalated");
  assert.equal(manifest.review.repeated_issue_count, 0);
});

test("rubric factor flip-flops escalate even when the reviewer returns pass", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({ verdict: "changes_requested", rubric_scores: [{ factor: "Behavior", status: "pass" }] }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({ verdict: "changes_requested", rubric_scores: [{ factor: "behavior", status: "fail" }] }), "utf-8");
  updateManifestRecord(manifestPath, (data) => ({ ...data, review: { ...(data.review || {}), rounds: 2 } }));
  const reviewFile = writeVerdict(repoRoot, "flip-pass.json", {
    verdict: "pass", summary: "Looks good.", contract_status: "pass", quality_review_status: "pass",
    quality_execution_status: "pass", next_action: "ready_to_merge", issues: [],
    rubric_scores: [{ factor: "BEHAVIOR", target: ">= 1/1", observed: "1/1", status: "pass", tier: "contract", notes: "Recovered." }],
    scope_drift: { creep: [], missing: [] },
  });
  const result = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--run-id", runId, "--pr", "123", "--done-criteria-file", doneCriteriaPath, "--diff-file", diffPath, "--review-file", reviewFile, "--no-comment", "--json"], { encoding: "utf-8" }));
  const verdict = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));
  assert.equal(result.state, STATES.ESCALATED);
  assert.equal(verdict.verdict, "escalated");
  assert.equal(verdict.summary, "Rubric factor 'BEHAVIOR' status flipped across 3 rounds (trace: pass→fail→pass). Owner decision required — reviewer cannot converge autonomously.");
});

test("formatPriorVerdictSummary produces correct round numbers and rubric summaries", () => {
  // Module-level argv parsing prevents direct require(), so use a helper script
  // that sets process.argv before requiring the module.
  const verdicts = [
    {
      verdict: "changes_requested",
      summary: "Missing tests",
      issues: [{ title: "a", body: "b", file: "x.js", line: 1, category: "contract", severity: "high" }],
      rubric_scores: [
        { factor: "Coverage", target: ">= 8", observed: "5", status: "fail", tier: "contract", notes: "low" },
      ],
    },
    {
      verdict: "changes_requested",
      summary: "No auth guard",
      issues: [
        { title: "c", body: "d", file: "y.js", line: 2, category: "quality", severity: "medium" },
        { title: "e", body: "f", file: "z.js", line: 3, category: "contract", severity: "high" },
      ],
      rubric_scores: [],
    },
  ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-unit-"));
  const helperPath = path.join(tmpDir, "helper.js");
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { formatPriorVerdictSummary } = require(${JSON.stringify(SCRIPT)});`,
    `const verdicts = ${JSON.stringify(verdicts)};`,
    `const result = formatPriorVerdictSummary(verdicts);`,
    `const empty = formatPriorVerdictSummary([]);`,
    `process.stdout.write(JSON.stringify({ result, empty }));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));

  assert.match(out.result, /^Prior review rounds:/);
  assert.match(out.result, /- Round 2: changes_requested — Missing tests \[1 issue\(s\), Coverage: 5 \(target >= 8, fail\)\]/);
  assert.match(out.result, /- Round 1: changes_requested — No auth guard \[2 issue\(s\), no rubric scores\]/);
  assert.equal(out.empty, "");
});

test("parseScoreLog extracts final scores and falls back to the last populated iteration", () => {
  const markdown = [
    "# PR",
    "",
    "## Score Log",
    "",
    "| Factor | Target | Baseline | Iter 1 | Iter 2 | Final | Status |",
    "|--------|--------|----------|--------|--------|-------|--------|",
    "| Coverage | >= 8 | — | 6 | 9 | 9 | locked |",
    "| Docs & Notes? | >= 8 | — | 6 | 7 | — | locked |",
    "| Placeholder | >= 8 | — | n/a | — | — | — |",
  ].join("\n");

  const out = JSON.parse(runReviewRunnerModule([
    `const result = reviewRunner.parseScoreLog(${JSON.stringify(markdown)});`,
    `process.stdout.write(JSON.stringify(result));`,
  ]));

  assert.deepEqual(out, [
    { factor: "Coverage", score: "9" },
    { factor: "Docs & Notes?", score: "7" },
  ]);
});

test("parseScoreLog returns [] for missing or malformed tables", () => {
  const out = JSON.parse(runReviewRunnerModule([
    `const missing = reviewRunner.parseScoreLog("No score log here");`,
    `const malformed = reviewRunner.parseScoreLog("| Factor | Final |\\n| bad | row |");`,
    `process.stdout.write(JSON.stringify({ missing, malformed }));`,
  ]));

  assert.deepEqual(out, {
    missing: [],
    malformed: [],
  });
});

test("round 2 review prompt contains Prior Round Context section", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  // Run round 1: changes_requested
  const reviewFile = writeVerdict(repoRoot, "r1-changes.json", {
    verdict: "changes_requested",
    summary: "Smoke file not created.",
    contract_status: "fail",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "changes_requested",
    issues: [{
      title: "Missing smoke file",
      body: "smoke.txt not found",
      file: "src/index.js",
      line: 10,
      category: "contract",
      severity: "high",
    }],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  // Transition back to review_pending for round 2
  setReviewPending(manifestPath);

  // Round 2: prepare-only to inspect the prompt
  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.round, 2);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /## Prior Round Context/);
  assert.match(promptText, /### Round 1: changes_requested/);
  assert.match(promptText, /Smoke file not created\./);
  assert.match(promptText, /Verify whether prior issues were resolved/);
});

test("round 2 redispatch artifact contains prior round summary", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  // Round 1: changes_requested
  const r1File = writeVerdict(repoRoot, "r1.json", {
    verdict: "changes_requested",
    summary: "Missing smoke file.",
    contract_status: "fail",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "changes_requested",
    issues: [{
      title: "No smoke.txt",
      body: "Add it.",
      file: "src/index.js",
      line: 5,
      category: "contract",
      severity: "high",
    }],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", r1File,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  setReviewPending(manifestPath);

  // Round 2: changes_requested again → triggers redispatch with prior summary
  const r2File = writeVerdict(repoRoot, "r2.json", {
    verdict: "changes_requested",
    summary: "Still missing.",
    contract_status: "fail",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "changes_requested",
    issues: [{
      title: "No smoke.txt",
      body: "Still not there.",
      file: "src/index.js",
      line: 5,
      category: "contract",
      severity: "high",
    }],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", r2File,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.ok(result.redispatchPath);
  const redispatchText = fs.readFileSync(result.redispatchPath, "utf-8");
  assert.match(redispatchText, /This is round 3/);
  assert.match(redispatchText, /Prior review rounds:/);
  assert.match(redispatchText, /Round 1: changes_requested — Missing smoke file\./);
});

// --- detectChurnGrowth unit tests ---

test("detectChurnGrowth returns null for round < 3", () => {
  const helperPath = path.join(os.tmpdir(), `churn-lt3-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `const r1 = detectChurnGrowth("/tmp/fake", 1);`,
    `const r2 = detectChurnGrowth("/tmp/fake", 2);`,
    `const rNull = detectChurnGrowth(null, 5);`,
    `process.stdout.write(JSON.stringify({ r1, r2, rNull }));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));
  assert.equal(out.r1, null);
  assert.equal(out.r2, null);
  assert.equal(out.rNull, null);
});

test("detectChurnGrowth returns growth object when diffs grow monotonically", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-grow-"));
  // 3 rounds with growing line counts: 2, 5, 10
  fs.writeFileSync(path.join(tmpDir, "review-round-1-diff.patch"), "a\nb\n");
  fs.writeFileSync(path.join(tmpDir, "review-round-2-diff.patch"), "a\nb\nc\nd\ne\n");
  fs.writeFileSync(path.join(tmpDir, "review-round-3-diff.patch"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");

  const helperPath = path.join(os.tmpdir(), `churn-grow-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `const result = detectChurnGrowth(${JSON.stringify(tmpDir)}, 3);`,
    `process.stdout.write(JSON.stringify(result));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));
  assert.deepEqual(out, { prevPrevLines: 2, prevLines: 5, curLines: 10 });
});

test("detectChurnGrowth returns null when diffs are not monotonically increasing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-nogrow-"));
  // Round 2 is bigger than round 3 (shrinking)
  fs.writeFileSync(path.join(tmpDir, "review-round-1-diff.patch"), "a\nb\n");
  fs.writeFileSync(path.join(tmpDir, "review-round-2-diff.patch"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
  fs.writeFileSync(path.join(tmpDir, "review-round-3-diff.patch"), "a\nb\nc\n");

  const helperPath = path.join(os.tmpdir(), `churn-nogrow-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `const result = detectChurnGrowth(${JSON.stringify(tmpDir)}, 3);`,
    `process.stdout.write(JSON.stringify({ result }));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));
  assert.equal(out.result, null);
});

test("detectChurnGrowth returns null when prior diff files are missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-missing-"));
  // Only current round exists, prior rounds missing
  fs.writeFileSync(path.join(tmpDir, "review-round-3-diff.patch"), "a\nb\nc\n");

  const helperPath = path.join(os.tmpdir(), `churn-missing-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `const result = detectChurnGrowth(${JSON.stringify(tmpDir)}, 3);`,
    `process.stdout.write(JSON.stringify({ result }));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));
  assert.equal(out.result, null);
});

test("detectChurnGrowth propagates non-ENOENT errors", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-err-"));
  // Current round file is a directory → EISDIR on read
  fs.mkdirSync(path.join(tmpDir, "review-round-3-diff.patch"));

  const helperPath = path.join(os.tmpdir(), `churn-err-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `try { detectChurnGrowth(${JSON.stringify(tmpDir)}, 3); process.stdout.write("no-error"); }`,
    `catch (e) { process.stdout.write(e.code || "unknown"); }`,
  ].join("\n"), "utf-8");
  const out = execFileSync("node", [helperPath], { encoding: "utf-8" });
  assert.equal(out, "EISDIR");
});

// --- buildRedispatchPrompt churnGrowth tests ---

test("buildRedispatchPrompt includes churn WARNING when churnGrowth is provided", () => {
  const helperPath = path.join(os.tmpdir(), `redispatch-churn-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { buildRedispatchPrompt } = require(${JSON.stringify(SCRIPT)});`,
    `const verdict = { verdict: "changes_requested", summary: "test", issues: [{ title: "t", body: "b", file: "x.js", line: 1, category: "contract", severity: "high" }], scope_drift: { creep: [], missing: [] } };`,
    `const churn = { prevPrevLines: 50, prevLines: 80, curLines: 120 };`,
    `const result = buildRedispatchPrompt(verdict, "AC: do X", null, 3, churn);`,
    `process.stdout.write(result);`,
  ].join("\n"), "utf-8");
  const out = execFileSync("node", [helperPath], { encoding: "utf-8" });
  assert.match(out, /WARNING: Diff has grown for 3\+ consecutive rounds \(50 → 80 → 120 lines\)/);
  assert.match(out, /Apply minimal, targeted fixes only/);
});

test("buildRedispatchPrompt omits churn WARNING when churnGrowth is null", () => {
  const helperPath = path.join(os.tmpdir(), `redispatch-nochurn-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { buildRedispatchPrompt } = require(${JSON.stringify(SCRIPT)});`,
    `const verdict = { verdict: "changes_requested", summary: "test", issues: [{ title: "t", body: "b", file: "x.js", line: 1, category: "contract", severity: "high" }], scope_drift: { creep: [], missing: [] } };`,
    `const result = buildRedispatchPrompt(verdict, "AC: do X", null, 3, null);`,
    `process.stdout.write(result);`,
  ].join("\n"), "utf-8");
  const out = execFileSync("node", [helperPath], { encoding: "utf-8" });
  assert.ok(!out.includes("WARNING"));
  assert.ok(!out.includes("Apply minimal"));
});

test("buildRedispatchPrompt includes prior-round factor flips", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "redispatch-factor-flips-"));
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "Behavior", status: "pass" }] }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "behavior", status: "fail" }] }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-3-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "BEHAVIOR", status: "pass" }] }), "utf-8");
  const helperPath = path.join(os.tmpdir(), `redispatch-flips-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { buildRedispatchPrompt } = require(${JSON.stringify(SCRIPT)});`,
    `const verdict = { verdict: "changes_requested", summary: "test", issues: [{ title: "t", body: "b", file: "x.js", line: 1, category: "contract", severity: "high" }], scope_drift: { creep: [], missing: [] } };`,
    `process.stdout.write(buildRedispatchPrompt(verdict, "AC: do X", ${JSON.stringify(runDir)}, 4, null));`,
  ].join("\n"), "utf-8");
  const out = execFileSync("node", [helperPath], { encoding: "utf-8" });
  assert.match(out, /Prior-round factor flips \(reviewer cannot converge on these — do NOT re-flag as blocker; owner decision needed\):/);
  assert.match(out, /- BEHAVIOR: pass→fail→pass/);
});

test("review-runner loads rubric from run dir and includes rubric factor names and targets in the prompt", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  // Write a rubric file to the run dir
  const { data, body } = readManifest(manifestPath);
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
    "rubric:",
    "  factors:",
    "    - name: API pagination",
    "      target: \">= 8/10\"",
  ].join("\n"), "utf-8");
  const nextAnchor = { ...(data.anchor || {}), rubric_path: "rubric.yaml" };
  delete nextAnchor.rubric_grandfathered;
  const updated = {
    ...data,
    anchor: nextAnchor,
  };
  writeManifest(manifestPath, updated, body);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.rubricLoaded, "loaded");
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /## Scoring Rubric/);
  assert.match(promptText, /API pagination/);
  assert.match(promptText, />= 8\/10/);
  assert.match(promptText, /rubric_scores.*REQUIRED/i);
});

// Covers #157 AC(f): a loaded rubric + PASS verdict MUST still advance to ready_to_merge; paired with the fail-closed regressions below at :1598-1660 (missing/outside/empty/invalid/not_set).
test("review-runner advances loaded-rubric PASS reviews to ready_to_merge", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  const { data, body } = readManifest(manifestPath);
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
    "rubric:",
    "  factors:",
    "    - name: API pagination",
    "      target: \">= 8/10\"",
  ].join("\n"), "utf-8");
  const nextAnchor = { ...(data.anchor || {}), rubric_path: "rubric.yaml" };
  delete nextAnchor.rubric_grandfathered;
  writeManifest(manifestPath, {
    ...data,
    anchor: nextAnchor,
  }, body);

  const reviewFile = writeVerdict(repoRoot, "loaded-rubric-pass.json", {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [
      {
        factor: "API pagination",
        target: ">= 8/10",
        observed: "9/10",
        status: "pass",
        tier: "contract",
        notes: "Pagination behavior meets the rubric target.",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  const result = runPassReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    reviewFile,
  });

  const manifest = readManifest(manifestPath).data;
  assert.equal(result.rubricLoaded, "loaded");
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.reviewGate, null);
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.next_action, "await_explicit_merge");
  assert.equal(manifest.review.latest_verdict, "lgtm");
  assert.equal(manifest.anchor.rubric_path, "rubric.yaml");
  assert.ok(!("rubric_grandfathered" in manifest.anchor));
});

test("review-runner warns visibly when anchor.rubric_path is set but the rubric file is missing", () => {
  // #153 enforcement-path coverage — originating findings: #148 file-existence/containment, #149 manifest resolution, #151 grandfather provenance
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  configureRubricFixture({ manifestPath, repoRoot, runId, state: "missing" });
  const rubricLoad = JSON.parse(runReviewRunnerModule([
    `const { loadRubricFromRunDir } = reviewRunner;`,
    `const result = loadRubricFromRunDir(${JSON.stringify(ensureRunLayout(repoRoot, runId).runDir)}, ${JSON.stringify(readManifest(manifestPath).data)});`,
    `process.stdout.write(JSON.stringify(result));`,
  ]));
  const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });
  assert.equal(rubricLoad.state, "missing");
  assert.match(rubricLoad.warning, /\[rubric missing\]/i);
  assert.equal(result.rubricLoaded, "missing");
  assert.match(result.rubricWarning, /\[rubric missing\]/i);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /## Scoring Rubric/);
  assert.match(promptText, /WARNING: \[rubric missing\]/i);
  assert.match(promptText, /Do NOT return PASS or ready_to_merge/i);
});

test("review-runner surfaces containment warnings for parent-relative and absolute rubric paths", async (t) => {
  // #153 enforcement-path coverage — originating findings: #148 file-existence/containment, #149 manifest resolution, #151 grandfather provenance
  for (const rubricPath of ["../escape.yaml", "/etc/passwd"]) {
    await t.test(rubricPath, () => {
      const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
      createEnforcementFixture({
        repoRoot,
        runId,
        manifestPath,
        state: "outside_run_dir",
        rubricPath,
      });
      const rubricLoad = JSON.parse(runReviewRunnerModule([
        `const { loadRubricFromRunDir } = reviewRunner;`,
        `const result = loadRubricFromRunDir(${JSON.stringify(ensureRunLayout(repoRoot, runId).runDir)}, ${JSON.stringify(readManifest(manifestPath).data)});`,
        `process.stdout.write(JSON.stringify(result));`,
      ]));
      const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });
      const promptText = fs.readFileSync(result.promptPath, "utf-8");

      assert.equal(rubricLoad.state, "outside_run_dir");
      assert.match(rubricLoad.warning, /\[rubric path outside run dir\]/i);
      assert.equal(result.rubricLoaded, "outside_run_dir");
      assert.match(result.rubricWarning, /\[rubric path outside run dir\]/i);
      assert.match(promptText, /WARNING: \[rubric path outside run dir\]/i);
      assert.match(promptText, new RegExp(rubricPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  }
});

test("review-runner warns visibly when anchor.rubric_path is missing from the manifest", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  configureRubricFixture({ manifestPath, repoRoot, runId, state: "not_set" });
  const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });

  assert.equal(result.rubricLoaded, "not_set");
  assert.match(result.rubricWarning, /\[rubric path not set\]/i);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /WARNING: \[rubric path not set\]/i);
  assert.match(promptText, /anchor\.rubric_path is required before review\/merge/i);
});

test("review-runner warns visibly when the anchored rubric file is empty", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  configureRubricFixture({ manifestPath, repoRoot, runId, state: "empty" });
  const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });

  assert.equal(result.rubricLoaded, "empty");
  assert.match(result.rubricWarning, /\[rubric empty\]/i);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /WARNING: \[rubric empty\]/i);
  assert.match(promptText, /rubric file is empty/i);
});

test("review-runner warns visibly when anchor.rubric_path points to an invalid rubric target", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  configureRubricFixture({ manifestPath, repoRoot, runId, state: "invalid" });
  const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });

  assert.equal(result.rubricLoaded, "invalid");
  assert.match(result.rubricWarning, /\[rubric invalid\]/i);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /WARNING: \[rubric invalid\]/i);
  assert.match(promptText, /must point to a file inside the run directory/i);
});

test("loadRubricFromRunDir returns the invalid warning branch when anchor.rubric_path is a symlink", () => {
  const { repoRoot, manifestPath, runId } = setupRepo();
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  const siblingTarget = path.join(runDir, "rubric-copy.yaml");
  fs.writeFileSync(siblingTarget, "rubric:\n  factors:\n    - name: sibling\n", "utf-8");
  fs.rmSync(path.join(runDir, "rubric.yaml"), { force: true });
  fs.symlinkSync(siblingTarget, path.join(runDir, "rubric.yaml"));

  const { data, body } = readManifest(manifestPath);
  const nextAnchor = { ...(data.anchor || {}), rubric_path: "rubric.yaml" };
  delete nextAnchor.rubric_grandfathered;
  writeManifest(manifestPath, {
    ...data,
    anchor: nextAnchor,
  }, body);

  const rubricLoad = JSON.parse(runReviewRunnerModule([
    `const { loadRubricFromRunDir } = reviewRunner;`,
    `const result = loadRubricFromRunDir(${JSON.stringify(runDir)}, ${JSON.stringify({
      ...data,
      anchor: nextAnchor,
    })});`,
    `process.stdout.write(JSON.stringify(result));`,
  ]));

  assert.equal(rubricLoad.state, "invalid");
  assert.equal(rubricLoad.status, "symlink_escape");
  assert.match(rubricLoad.warning, /\[rubric invalid\]/i);
  assert.match(rubricLoad.warning, /must not be a symlink/i);
});

test("review-runner rejects empty rubric_scores when rubric is present", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  // Write a rubric file to the run dir
  const { data, body } = readManifest(manifestPath);
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: test\n", "utf-8");
  const nextAnchor = { ...(data.anchor || {}), rubric_path: "rubric.yaml" };
  delete nextAnchor.rubric_grandfathered;
  const updated = {
    ...data,
    anchor: nextAnchor,
  };
  writeManifest(manifestPath, updated, body);

  const reviewFile = writeVerdict(repoRoot, "empty-rubric.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /empty rubric_scores.*rubric was provided/i);
});

test("review-runner fails closed when the manifest still carries anchor.rubric_grandfathered", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const rubricGrandfathered = createGrandfatheredRubricAnchor({
    actor: "review-runner-test",
  });
  updateManifestRecord(manifestPath, (data) => ({
    ...data,
    anchor: {
      rubric_path: "rubric.yaml",
      rubric_grandfathered: rubricGrandfathered,
    },
  }));
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), DEFAULT_ENFORCEMENT_RUBRIC, "utf-8");

  const reviewFile = writeVerdict(repoRoot, "no-rubric-pass.json", {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  const result = runPassReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    reviewFile,
    noComment: true,
  });

  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.equal(result.appliedVerdict, "changes_requested");
  assert.equal(result.reviewGate.status, "rubric_state_failed_closed");
  assert.equal(result.reviewGate.layer, "review-runner");
  assert.equal(result.reviewGate.rubricState, "invalid");
  assert.match(result.reviewGate.reason, /anchor\.rubric_grandfathered is no longer supported/);
  assert.match(result.reviewGate.recovery, /Fix or replace the rubric anchor/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CHANGES_REQUESTED);
  assert.equal(manifest.review.latest_verdict, "rubric_state_failed_closed");
  assert.match(
    manifest.review.last_gate.reason,
    /anchor\.rubric_grandfathered is no longer supported/
  );
});

[
  {
    state: "missing",
    recovery: /Restore or replace the missing rubric, then run `node skills\/relay-dispatch\/scripts\/dispatch\.js \. --run-id/i,
  },
  {
    state: "outside_run_dir",
    recovery: /Replace the escaped rubric anchor with a contained rubric, then run `node skills\/relay-dispatch\/scripts\/dispatch\.js \. --run-id/i,
  },
  {
    state: "empty",
    recovery: /Regenerate the empty rubric, then run `node skills\/relay-dispatch\/scripts\/dispatch\.js \. --run-id/i,
  },
  {
    state: "invalid",
    recovery: /Fix or replace the rubric anchor, then run `node skills\/relay-dispatch\/scripts\/dispatch\.js \. --run-id/i,
  },
  {
    state: "not_set",
    recovery: /Persist a rubric for this run, then run `node skills\/relay-dispatch\/scripts\/dispatch\.js \. --run-id/i,
  },
].forEach(({ state, recovery }) => {
  test(`review-runner fail-closes PASS when rubric state is ${state}`, () => {
    const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
    const commentCapturePath = path.join(repoRoot, `${state}-review-comment.txt`);

    configureRubricFixture({ manifestPath, repoRoot, runId, state });
    writeFakeGhScript(repoRoot, {
      capturePath: commentCapturePath,
      prBody: "",
    });
    const reviewFile = writePassVerdict(repoRoot, `${state}-pass.json`);
    const result = runPassReview({
      repoRoot,
      runId,
      doneCriteriaPath,
      diffPath,
      reviewFile,
      noComment: false,
      env: {
        ...process.env,
        PATH: `${repoRoot}:${process.env.PATH}`,
      },
    });

    const manifest = readManifest(manifestPath).data;
    const verdictRecord = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));
    const commentBody = fs.readFileSync(commentCapturePath, "utf-8");

    assert.equal(result.rubricLoaded, state);
    assert.equal(result.state, STATES.CHANGES_REQUESTED);
    assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
    assert.equal(result.appliedVerdict, "changes_requested");
    assert.ok(result.redispatchPath);
    assert.equal(result.reviewGate.status, "rubric_state_failed_closed");
    assert.equal(result.reviewGate.layer, "review-runner");
    assert.equal(result.reviewGate.rubricState, state);
    assert.match(
      result.reviewGate.recoveryCommand,
      new RegExp(`--run-id ${runId} --prompt-file ${result.redispatchPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`)
    );
    assert.match(result.reviewGate.recovery, recovery);

    assert.equal(manifest.state, STATES.CHANGES_REQUESTED);
    assert.equal(manifest.next_action, "repair_rubric_and_redispatch");
    assert.equal(manifest.review.latest_verdict, "rubric_state_failed_closed");
    assert.equal(manifest.review.last_gate.layer, "review-runner");
    assert.equal(manifest.review.last_gate.rubric_state, state);
    assert.match(
      manifest.review.last_gate.recovery_command,
      new RegExp(`--run-id ${runId} --prompt-file ${result.redispatchPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`)
    );
    assert.match(manifest.review.last_gate.recovery, recovery);

    assert.equal(verdictRecord.verdict, "pass");
    assert.equal(verdictRecord.next_action, "ready_to_merge");
    assert.equal(verdictRecord.relay_gate.status, "rubric_state_failed_closed");
    assert.equal(verdictRecord.relay_gate.layer, "review-runner");
    assert.equal(verdictRecord.relay_gate.rubric_state, state);
    assert.match(
      verdictRecord.relay_gate.recovery_command,
      new RegExp(`--run-id ${runId} --prompt-file ${result.redispatchPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`)
    );
    assert.match(verdictRecord.relay_gate.recovery, recovery);

    assert.match(commentBody, /Verdict: CHANGES_REQUESTED/);
    assert.match(commentBody, /Gate status: rubric_state_failed_closed/);
    assert.match(commentBody, /Layer: review-runner/);
    assert.match(commentBody, new RegExp(`Rubric state: ${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(
      commentBody,
      new RegExp(
        `Recovery command: node skills/relay-dispatch/scripts/dispatch\\.js \\. --run-id ${runId} --prompt-file ${result.redispatchPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`
      )
    );
    assert.match(commentBody, recovery);
  });
});

test("review-runner fail-closed path can re-dispatch with a fixed rubric and pass the next review", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  configureRubricFixture({ manifestPath, repoRoot, runId, state: "missing" });

  const firstReviewFile = writePassVerdict(repoRoot, "missing-pass.json");
  const firstRound = runPassReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    reviewFile: firstReviewFile,
  });
  assert.equal(firstRound.state, STATES.CHANGES_REQUESTED);
  assert.ok(firstRound.redispatchPath);

  const fixedRubricPath = path.join(repoRoot, "fixed-rubric.yaml");
  fs.writeFileSync(fixedRubricPath, [
    "rubric:",
    "  factors:",
    "    - name: API pagination",
    "      target: \">= 8/10\"",
  ].join("\n"), "utf-8");

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-codex-bin-"));
  writeFakeCodex(binDir);
  const dispatch = spawnSync("node", [
    DISPATCH_SCRIPT,
    repoRoot,
    "--run-id", runId,
    "--prompt-file", firstRound.redispatchPath,
    "--rubric-file", fixedRubricPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
    },
  });
  assert.equal(dispatch.status, 0, dispatch.stderr || dispatch.stdout);
  const dispatchResult = JSON.parse(dispatch.stdout);

  assert.equal(dispatchResult.mode, "resume");
  assert.equal(dispatchResult.runState, STATES.REVIEW_PENDING);

  const secondReviewFile = writeVerdict(repoRoot, "loaded-pass.json", {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [
      {
        factor: "API pagination",
        target: ">= 8/10",
        observed: "9/10",
        status: "pass",
        tier: "contract",
        notes: "Pagination behavior meets the rubric target.",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });
  const secondRound = runPassReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    reviewFile: secondReviewFile,
  });

  assert.equal(secondRound.round, 2);
  assert.equal(secondRound.rubricLoaded, "loaded");
  assert.equal(secondRound.state, STATES.READY_TO_MERGE);
  assert.equal(secondRound.nextState, STATES.READY_TO_MERGE);
  assert.equal(secondRound.appliedVerdict, "pass");

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.next_action, "await_explicit_merge");
  assert.equal(manifest.review.latest_verdict, "lgtm");
  assert.equal(manifest.review.last_gate, null);
});

// -------------------------------------------------------------------------
// getGhLogin --hostname resolution (issue #199)
// -------------------------------------------------------------------------

const {
  parseRemoteHost,
  resolveRemoteHost,
  getGhLogin,
} = require("./review-runner");

test("parseRemoteHost extracts host from HTTPS origin", () => {
  assert.equal(parseRemoteHost("https://ghe.corp.example.com/owner/repo.git"), "ghe.corp.example.com");
  assert.equal(parseRemoteHost("http://example.org/owner/repo"), "example.org");
  assert.equal(parseRemoteHost("https://github.com/sungjunlee/dev-relay.git"), "github.com");
});

test("parseRemoteHost strips credentials and ports from HTTPS origins", () => {
  // Regex-based extraction would return "user@host"; URL parsing returns
  // just the host. `gh --hostname "user@host"` is not valid.
  assert.equal(parseRemoteHost("https://user@ghe.corp.example.com/owner/repo.git"), "ghe.corp.example.com");
  assert.equal(parseRemoteHost("https://user:token@ghe.corp.example.com/owner/repo.git"), "ghe.corp.example.com");
  assert.equal(parseRemoteHost("https://ghe.corp.example.com:8443/owner/repo.git"), "ghe.corp.example.com");
});

test("parseRemoteHost extracts host from SSH origin (scp-like)", () => {
  assert.equal(parseRemoteHost("git@ghe.corp.example.com:owner/repo.git"), "ghe.corp.example.com");
  assert.equal(parseRemoteHost("git@github.com:sungjunlee/dev-relay.git"), "github.com");
});

test("parseRemoteHost accepts scp-like SSH without an explicit user", () => {
  // Git allows `host:path` as a valid scp-like remote (no `user@`). Without
  // this, a non-default-host repo whose origin omitted the user would
  // silently fall into the no-host path in getGhLogin and use zero-arg gh —
  // the exact regression #199 is filed to close.
  assert.equal(parseRemoteHost("ghe.corp.example.com:owner/repo.git"), "ghe.corp.example.com");
  assert.equal(parseRemoteHost("github.com:sungjunlee/dev-relay.git"), "github.com");
});

test("parseRemoteHost rejects Windows-style local paths that look scp-like", () => {
  // Single-ASCII-letter `host` is almost certainly a drive letter, not a
  // remote. Git's legacy heuristic would parse `C:/foo/bar` as scp-like,
  // but we reject it to avoid `gh --hostname C` argv surprises.
  assert.equal(parseRemoteHost("C:/Users/relay/project"), null);
  assert.equal(parseRemoteHost("D:/repos/dev-relay"), null);
  assert.equal(parseRemoteHost("x:/tmp/scratch"), null);
});

test("parseRemoteHost extracts host from ssh:// URL form", () => {
  assert.equal(parseRemoteHost("ssh://git@ghe.corp.example.com/owner/repo.git"), "ghe.corp.example.com");
  assert.equal(parseRemoteHost("ssh://ghe.corp.example.com/owner/repo.git"), "ghe.corp.example.com");
});

test("parseRemoteHost returns null for empty or unrecognized input", () => {
  assert.equal(parseRemoteHost(""), null);
  assert.equal(parseRemoteHost(null), null);
  assert.equal(parseRemoteHost(undefined), null);
  assert.equal(parseRemoteHost("not a url"), null);
});

test("parseRemoteHost rejects hosts that are not valid DNS labels", () => {
  // Leading-dash hosts — could be interpreted as flags by some CLI tools.
  assert.equal(parseRemoteHost("git@-hostile:owner/repo.git"), null);
  assert.equal(parseRemoteHost("ssh://-hostile/owner/repo.git"), null);
  // Whitespace in host.
  assert.equal(parseRemoteHost("https://ex ample.com/owner/repo"), null);
  // Trailing dash / invalid label.
  assert.equal(parseRemoteHost("git@host-:owner/repo.git"), null);
  // Double-@ ambiguity — scp-like form with multiple @ before colon is
  // rejected because we anchor left of the FIRST @ on a char class that
  // disallows @.
  assert.equal(parseRemoteHost("a@b@c:d/e"), null);
});

test("resolveRemoteHost returns origin host from a real git repo (HTTPS)", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-host-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", "https://ghe.corp.example.com/owner/repo.git"], {
    cwd: repoRoot, encoding: "utf-8", stdio: "pipe",
  });
  assert.equal(resolveRemoteHost(repoRoot), "ghe.corp.example.com");
});

test("resolveRemoteHost returns origin host from a real git repo (SSH)", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-host-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", "git@ghe.corp.example.com:owner/repo.git"], {
    cwd: repoRoot, encoding: "utf-8", stdio: "pipe",
  });
  assert.equal(resolveRemoteHost(repoRoot), "ghe.corp.example.com");
});

test("resolveRemoteHost returns null when origin is missing", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-host-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  // No remote configured.
  assert.equal(resolveRemoteHost(repoRoot), null);
});

test("resolveRemoteHost returns null when repoPath is falsy", () => {
  assert.equal(resolveRemoteHost(null), null);
  assert.equal(resolveRemoteHost(undefined), null);
  assert.equal(resolveRemoteHost(""), null);
});

function withShimmedPath(shimDir, captured, body) {
  const originalPath = process.env.PATH;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  // Prepend the shim and keep the real PATH so other helpers (e.g. /bin/sh)
  // still resolve. gh/git resolve to the shim because it's first.
  process.env.PATH = `${shimDir}:${originalPath}`;
  try {
    return body();
  } finally {
    process.env.PATH = originalPath;
    process.stderr.write = originalStderrWrite;
  }
}

function writeShim(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, "utf-8");
  fs.chmodSync(file, 0o755);
  return file;
}

test("getGhLogin is fail-closed when origin resolves, gh has auth, but the host-scoped call fails", () => {
  // The PR-208 critical bug: previously, when origin resolved to a non-default
  // host and host-scoped `gh api user --hostname <host>` failed, the fallback
  // would silently succeed on `gh api user` (default host) and write the
  // operator's personal github.com login into reviewer_login. gate-check then
  // rejected the PR as unauthorized_reviewer. Verify the fallback is gone.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-shim-"));
  // Fake gh:
  //   `gh auth status --hostname <host>` → exit 0 (host IS authed).
  //   `gh api user --hostname <host>` → exit 4 (API call fails anyway).
  //   `gh api user` (zero-arg) → would return default-host login; a
  //      regression to two-stage fallback would let it leak into
  //      reviewer_login.
  writeShim(shimDir, "gh", [
    '#!/bin/sh',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
    'for arg in "$@"; do',
    '  if [ "$arg" = "--hostname" ]; then',
    '    exit 4',
    '  fi',
    'done',
    'echo personal-default-host-login',
    '',
  ].join("\n"));
  // Fake git: return the enterprise origin URL so resolveRemoteHost picks
  // up a non-default host and we actually exercise the --hostname code path.
  writeShim(shimDir, "git", [
    '#!/bin/sh',
    'if [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then',
    '  echo https://ghe.corp.example.com/owner/repo.git',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join("\n"));

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-host-"));
  const captured = [];
  const result = withShimmedPath(shimDir, captured, () => getGhLogin(repoRoot));
  assert.equal(result.login, null, "must not silently leak a default-host login");
  // Signal the merge gate so reviewer_login_required can be persisted on the
  // manifest — without this, fail-closed in getGhLogin silently degrades to
  // a skipped verification gate in relay-merge/gate-check.
  assert.equal(result.status, "host_auth_failed");
  const warning = captured.join("");
  assert.match(warning, /ghe\.corp\.example\.com/);
  assert.match(warning, /reviewer_login will not be recorded/);
});

test("getGhLogin falls back to zero-arg gh when origin host has no gh auth (e.g. ssh.github.com)", () => {
  // Round-5 codex finding: transport-only hosts (ssh.github.com for a
  // github.com repo, or GHES installs where SSH and API are on different
  // hostnames) would previously fail with host_auth_failed even though
  // the operator IS fully authed on the API host. Fix: probe
  // `gh auth status --hostname <host>` first; if gh doesn't know about
  // this host, fall back to zero-arg — same host `gh pr comment` uses,
  // so reviewer_login lines up with the actual comment author.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-shim-"));
  writeShim(shimDir, "gh", [
    '#!/bin/sh',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
    '  # The transport host is NOT a known gh host.',
    '  exit 1',
    'fi',
    'for arg in "$@"; do',
    '  if [ "$arg" = "--hostname" ]; then',
    '    # Must not be called in this case.',
    '    exit 5',
    '  fi',
    'done',
    'echo personal-github-login',
    '',
  ].join("\n"));
  writeShim(shimDir, "git", [
    '#!/bin/sh',
    'if [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then',
    '  echo ssh://git@ssh.github.com:443/sungjunlee/dev-relay.git',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join("\n"));

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-host-"));
  const captured = [];
  const result = withShimmedPath(shimDir, captured, () => getGhLogin(repoRoot));
  assert.equal(result.login, "personal-github-login");
  assert.equal(result.status, "recorded");
});

test("getGhLogin uses zero-arg gh when no origin host is resolvable", () => {
  // When the repo has no origin (manifest-only run or non-git scratch dir),
  // zero-arg gh is the only signal available — the operator's default host is
  // the host in scope, so the match is unambiguous.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-shim-"));
  writeShim(shimDir, "gh", [
    '#!/bin/sh',
    'for arg in "$@"; do',
    '  if [ "$arg" = "--hostname" ]; then',
    '    # Should not be called in this case.',
    '    exit 5',
    '  fi',
    'done',
    'echo default-host-login',
    '',
  ].join("\n"));
  writeShim(shimDir, "git", [
    '#!/bin/sh',
    '# No remote configured — exit non-zero for remote get-url.',
    'if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then',
    '  exit 2',
    'fi',
    'exit 0',
    '',
  ].join("\n"));

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-host-"));
  const captured = [];
  const result = withShimmedPath(shimDir, captured, () => getGhLogin(repoRoot));
  assert.equal(result.login, "default-host-login");
  assert.equal(result.status, "recorded");
});

test("getGhLogin does not crash when both origin-resolution and gh fail", () => {
  // Total-failure case: no origin, gh also unavailable. Must emit a warning
  // and return { login: null, status: "no_login" }, not throw. Status is
  // NOT "host_auth_failed" because we never resolved a host to fail on —
  // gate-check's current "missing login → soft skip" behavior is preserved.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-shim-"));
  writeShim(shimDir, "gh", "#!/bin/sh\nexit 4\n");
  writeShim(shimDir, "git", "#!/bin/sh\nexit 2\n");

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-host-"));
  const captured = [];
  const result = withShimmedPath(shimDir, captured, () => getGhLogin(repoRoot));
  assert.equal(result.login, null);
  assert.equal(result.status, "no_login");
  const warning = captured.join("");
  assert.match(warning, /reviewer_login will not be recorded/);
});
