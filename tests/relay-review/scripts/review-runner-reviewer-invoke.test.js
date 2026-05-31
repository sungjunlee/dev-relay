const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { STATES, updateManifestState } = require("../../../skills/relay-dispatch/scripts/manifest/lifecycle");
const { ensureRunLayout, getEventsPath } = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const { createManifestSkeleton, readManifest, writeManifest } = require("../../../skills/relay-dispatch/scripts/manifest/store");
const { buildDefaultRelayPolicy } = require("../../../skills/relay-dispatch/scripts/relay-policy");
const { ADAPTER_PHASES } = require("../../../skills/relay-dispatch/scripts/agent-adapters");
const {
  buildPrimaryReviewerPolicy,
  captureGitStatus,
  loadRunRoutePlan,
  loadReviewText,
  resolveReviewerName,
  resolveReviewerScript,
} = require("../../../skills/relay-review/scripts/review-runner/reviewer-invoke");

function setupReviewRun() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-invoke-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });

  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  const runId = "issue-189-20260418020202020";
  const { runDir, manifestPath } = ensureRunLayout(repoRoot, runId);
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: Behavior\n", "utf-8");

  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-189",
    baseBranch: "main",
    issueNumber: 189,
    worktreePath: path.join(repoRoot, "wt", "issue-189"),
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });
  manifest = {
    ...manifest,
    anchor: {
      ...(manifest.anchor || {}),
      rubric_path: "rubric.yaml",
    },
  };
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest, "# Notes\n");

  const promptPath = path.join(runDir, "prompt.md");
  fs.writeFileSync(promptPath, "Return a passing review.\n", "utf-8");

  return {
    relayHome,
    repoRoot,
    runDir,
    manifestPath,
    manifest,
    promptPath,
    runId,
  };
}

function writeExecutable(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeReviewerArgEchoScript(dir, name = "reviewer-echo-argv.js") {
  return writeExecutable(dir, name, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  verdict: "pass",
  summary: "ok",
  contract_status: "pass",
  quality_review_status: "pass",
  next_action: "ready_to_merge",
  issues: [],
  rubric_scores: [],
  scope_drift: { creep: [], missing: [] },
  argv: process.argv.slice(2),
}) + "\\n");
`);
}

function writeRelayPolicy(relayHome, overrides = {}) {
  fs.writeFileSync(path.join(relayHome, "policy.json"), JSON.stringify({
    ...buildDefaultRelayPolicy(),
    ...overrides,
  }, null, 2), "utf-8");
}

test("reviewer-invoke/resolveReviewerName preserves arg, manifest, env precedence", (t) => {
  const originalReviewer = process.env.RELAY_REVIEWER;
  t.after(() => {
    if (originalReviewer === undefined) {
      delete process.env.RELAY_REVIEWER;
      return;
    }
    process.env.RELAY_REVIEWER = originalReviewer;
  });

  process.env.RELAY_REVIEWER = "env-reviewer";
  assert.equal(resolveReviewerName({ roles: { reviewer: "manifest-reviewer" } }, "arg-reviewer"), "arg-reviewer");
  assert.equal(resolveReviewerName({ roles: { reviewer: "manifest-reviewer" } }), "env-reviewer");
  assert.equal(resolveReviewerName({ roles: { reviewer: "unknown" } }), "env-reviewer");
  process.env.RELAY_REVIEWER = "   ";
  assert.equal(resolveReviewerName({ roles: { reviewer: "manifest-reviewer" } }), "manifest-reviewer");
});

test("reviewer-invoke/resolveReviewerName uses route-plan reviewer before manifest role", (t) => {
  const originalReviewer = process.env.RELAY_REVIEWER;
  t.after(() => {
    if (originalReviewer === undefined) {
      delete process.env.RELAY_REVIEWER;
      return;
    }
    process.env.RELAY_REVIEWER = originalReviewer;
  });

  delete process.env.RELAY_REVIEWER;
  const routePlan = {
    phases: {
      review: { reviewer: "opencode", model: "opencode-go/deepseek-v4-pro" },
    },
  };

  assert.equal(resolveReviewerName({ roles: { reviewer: "codex" } }, null, { routePlan }), "opencode");
  process.env.RELAY_REVIEWER = "claude";
  assert.equal(resolveReviewerName({ roles: { reviewer: "codex" } }, null, { routePlan }), "claude");
  assert.equal(resolveReviewerName({ roles: { reviewer: "codex" } }, "pi", { routePlan }), "pi");
});

test("reviewer-invoke/loadRunRoutePlan reads route-plan.json when present", () => {
  const { repoRoot, runId, runDir } = setupReviewRun();
  const planPath = path.join(runDir, "route-plan.json");
  fs.writeFileSync(planPath, JSON.stringify({
    version: 1,
    phases: {
      review: { reviewer: "codex", model: null },
    },
  }, null, 2), "utf-8");

  const loaded = loadRunRoutePlan(repoRoot, runId);

  assert.equal(loaded.path, planPath);
  assert.equal(loaded.plan.phases.review.reviewer, "codex");
});

test("reviewer-invoke/resolveReviewerScript resolves built-in adapters and rejects invalid names", () => {
  const script = resolveReviewerScript("codex");
  assert.match(script, /invoke-reviewer-codex\.js$/);
  const opencodeScript = resolveReviewerScript("opencode");
  assert.match(opencodeScript, /invoke-reviewer-opencode\.js$/);
  const piScript = resolveReviewerScript("pi");
  assert.match(piScript, /invoke-reviewer-pi\.js$/);
  const cursorScript = resolveReviewerScript("cursor");
  assert.match(cursorScript, /invoke-reviewer-cursor\.js$/);
  assert.throws(() => resolveReviewerScript("../bad"), /Invalid reviewer name/);
});

test("reviewer-invoke/resolveReviewerScript allows parity adapters for advisory review", () => {
  const script = resolveReviewerScript("opencode", null, { phase: ADAPTER_PHASES.ADVISORY_REVIEW });
  assert.match(script, /invoke-reviewer-opencode\.js$/);
  assert.match(resolveReviewerScript("pi", null, { phase: ADAPTER_PHASES.ADVISORY_REVIEW }), /invoke-reviewer-pi\.js$/);
  assert.match(resolveReviewerScript("antigravity", null, { phase: ADAPTER_PHASES.ADVISORY_REVIEW }), /invoke-reviewer-antigravity\.js$/);
  assert.throws(
    () => resolveReviewerScript("cursor", null, { phase: ADAPTER_PHASES.ADVISORY_REVIEW }),
    /not advisory_review/
  );
});

test("reviewer-invoke/resolveReviewerScript rejects unknown adapter names without falling back to files", () => {
  assert.throws(
    () => resolveReviewerScript("not-an-adapter"),
    /Unknown reviewer adapter 'not-an-adapter'.*Supported adapters:.*codex.*opencode.*pi.*--reviewer-script/s
  );
});

test("reviewer-invoke/buildPrimaryReviewerPolicy records Pi tool allowlist metadata", () => {
  const policy = buildPrimaryReviewerPolicy("pi");
  assert.equal(policy.adapter, "pi");
  assert.equal(policy.phase, ADAPTER_PHASES.PRIMARY_REVIEW);
  assert.equal(policy.safe, true);
  assert.equal(policy.read_only.enforcement_level, "tool-allowlist");
  assert.deepEqual(policy.read_only.flags, ["--tools read,grep,find,ls"]);
});

test("reviewer-invoke/buildPrimaryReviewerPolicy records OpenCode primary review status guard metadata", () => {
  const policy = buildPrimaryReviewerPolicy("opencode");
  assert.equal(policy.adapter, "opencode");
  assert.equal(policy.phase, ADAPTER_PHASES.PRIMARY_REVIEW);
  assert.equal(policy.safe, true);
  assert.equal(policy.sandbox.enforcement_level, "informational");
  assert.equal(policy.read_only.enforcement_level, "prompt-only");
  assert.match(policy.read_only.warnings.join("\n"), /does not prevent writes/i);
});

test("reviewer-invoke/buildPrimaryReviewerPolicy records Cursor ask-mode metadata", () => {
  const policy = buildPrimaryReviewerPolicy("cursor");
  assert.equal(policy.adapter, "cursor");
  assert.equal(policy.phase, ADAPTER_PHASES.PRIMARY_REVIEW);
  assert.equal(policy.safe, true);
  assert.equal(policy.sandbox.enforcement_level, "informational");
  assert.deepEqual(policy.sandbox.flags, ["--mode", "ask", "--trust", "--force", "--workspace"]);
  assert.equal(policy.read_only.enforcement_level, "prompt-only");
});

test("reviewer-invoke/buildPrimaryReviewerPolicy records Antigravity CLI version metadata", (t) => {
  const original = process.env.RELAY_ANTIGRAVITY_BIN;
  t.after(() => {
    if (original === undefined) {
      delete process.env.RELAY_ANTIGRAVITY_BIN;
      return;
    }
    process.env.RELAY_ANTIGRAVITY_BIN = original;
  });

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-policy-antigravity-"));
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("agy 1.0.2\\n");
  process.exit(0);
}
process.exit(2);
`);
  process.env.RELAY_ANTIGRAVITY_BIN = fakeAgy;

  const policy = buildPrimaryReviewerPolicy("antigravity");
  assert.equal(policy.adapter, "antigravity");
  assert.equal(policy.phase, ADAPTER_PHASES.PRIMARY_REVIEW);
  assert.equal(policy.safe, true);
  assert.equal(policy.cli.binary, fakeAgy);
  assert.equal(policy.cli.version, "agy 1.0.2");
  assert.equal(policy.cli.version_probe, "agy --version");
  assert.equal(policy.cli.error, null);
  assert.equal(policy.sandbox.enforcement_level, "native");
  assert.equal(policy.read_only.enforcement_level, "prompt-only");
});

test("reviewer-invoke/resolveReviewerScript preserves manual reviewer-script overrides", () => {
  const customScript = path.join(os.tmpdir(), "custom-reviewer.js");
  assert.equal(resolveReviewerScript("opencode", customScript), customScript);
  assert.equal(resolveReviewerScript("unknown", customScript, { phase: ADAPTER_PHASES.ADVISORY_REVIEW }), customScript);
});

test("reviewer-invoke/loadReviewText forwards promptPath to the adapter and persists the raw response", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-review-models",
    allowed_model_routes: [{ route: "opus", phases: ["review"], reviewers: ["codex"] }],
  });

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeExecutable(helperDir, "reviewer-reads-prompt.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const promptIndex = args.indexOf("--prompt-file");
const promptPath = promptIndex !== -1 ? args[promptIndex + 1] : null;
if (!promptPath || promptPath === "undefined") {
  process.stderr.write("missing prompt path\\n");
  process.exit(7);
}
process.stdout.write(JSON.stringify({
  promptPath,
  promptText: fs.readFileSync(promptPath, "utf-8").trim(),
}) + "\\n");
`);

  const { rawResponsePath, reviewText } = loadReviewText({
    body: "# Notes\n",
    data: manifest,
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: null,
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  });

  assert.ok(rawResponsePath);
  assert.equal(fs.readFileSync(rawResponsePath, "utf-8"), `${reviewText}\n`);
  assert.deepEqual(JSON.parse(reviewText), {
    promptPath,
    promptText: "Return a passing review.",
  });
});

test("reviewer-invoke precedence R1 regression: CLI reviewerModel beats manifest hint in reviewer argv", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-review-models",
    allowed_model_routes: [{ route: "opus", phases: ["review"], reviewers: ["codex"] }],
  });

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeReviewerArgEchoScript(helperDir, "reviewer-r1.js");

  const { reviewText } = loadReviewText({
    body: "# Notes\n",
    data: {
      ...manifest,
      model_hints: {
        review: "haiku",
      },
    },
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: "opus",
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  });

  assert.deepEqual(JSON.parse(reviewText).argv, [
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
    "--model", "opus",
  ]);
});

test("reviewer-invoke precedence R2 regression: CLI reviewerModel works when manifest hint is absent", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-review-models",
    allowed_model_routes: [{ route: "opus", phases: ["review"], reviewers: ["codex"] }],
  });

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeReviewerArgEchoScript(helperDir, "reviewer-r2.js");

  const { reviewText } = loadReviewText({
    body: "# Notes\n",
    data: manifest,
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: "opus",
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  });

  assert.deepEqual(JSON.parse(reviewText).argv, [
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
    "--model", "opus",
  ]);
});

test("reviewer-invoke precedence R3 regression: manifest hint supplies the effective reviewer model when CLI is unset", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath, runId } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-review-models",
    allowed_model_routes: [{ route: "haiku", phases: ["review"], reviewers: ["codex"] }],
  });

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeReviewerArgEchoScript(helperDir, "reviewer-r3.js");

  const { reviewText } = loadReviewText({
    body: "# Notes\n",
    data: {
      ...manifest,
      model_hints: {
        review: "haiku",
      },
    },
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: null,
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  });

  assert.deepEqual(JSON.parse(reviewText).argv, [
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
    "--model", "haiku",
  ]);

  const eventLines = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8").trim().split("\n").filter(Boolean);
  const reviewInvokeEvent = JSON.parse(eventLines.at(-1));
  assert.equal(reviewInvokeEvent.event, "review_invoke");
  assert.equal(reviewInvokeEvent.model, "haiku");
  assert.equal(reviewInvokeEvent.policy_decision.allowed, true);
  assert.equal(reviewInvokeEvent.policy_decision.reason, "allowed_model_route");
  assert.equal(reviewInvokeEvent.reviewer_policy.adapter, "custom-reviewer-script");
  assert.equal(reviewInvokeEvent.reviewer_policy.read_only.enforcement_level, "informational");
  assert.deepEqual(reviewInvokeEvent.reviewer_policy.read_only.flags, []);
  assert.match(reviewInvokeEvent.reviewer_policy.read_only.warnings.join("\n"), /outside adapter-managed containment/i);
});

test("reviewer-invoke route-plan review model wins over manifest model hint", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath, runId } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-review-route-plan",
    allowed_model_routes: [{ route: "opus", phases: ["review"], reviewers: ["codex"] }],
  });

  const routePlan = {
    phases: {
      review: { reviewer: "codex", model: "opus", sources: { reviewer: "route_plan", model: "route_plan" } },
    },
  };
  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeReviewerArgEchoScript(helperDir, "reviewer-route-plan-model.js");

  const { reviewText } = loadReviewText({
    body: "# Notes\n",
    data: {
      ...manifest,
      model_hints: {
        review: "haiku",
      },
    },
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: null,
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
    routePlan,
  });

  assert.deepEqual(JSON.parse(reviewText).argv, [
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
    "--model", "opus",
  ]);

  const eventLines = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8").trim().split("\n").filter(Boolean);
  const reviewInvokeEvent = JSON.parse(eventLines.at(-1));
  assert.equal(reviewInvokeEvent.event, "review_invoke");
  assert.equal(reviewInvokeEvent.model, "opus");
  assert.equal(reviewInvokeEvent.route_source, "route_plan");
});

test("reviewer-invoke/loadReviewText records adapter-managed primary reviewer read-only policy", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const originalCodexBin = process.env.RELAY_CODEX_BIN;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath, runId } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = originalRelayHome;
    }
    if (originalCodexBin === undefined) {
      delete process.env.RELAY_CODEX_BIN;
    } else {
      process.env.RELAY_CODEX_BIN = originalCodexBin;
    }
  });
  process.env.RELAY_HOME = relayHome;

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  process.env.RELAY_CODEX_BIN = writeExecutable(helperDir, "fake-codex.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
if (outputIndex === -1 || !args[outputIndex + 1]) {
  process.stderr.write("missing -o result path\\n");
  process.exit(2);
}
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  verdict: "pass",
  summary: "ok",
  contract_status: "pass",
  quality_review_status: "pass",
  next_action: "ready_to_merge",
  issues: [],
  rubric_scores: [],
  scope_drift: { creep: [], missing: [] }
}) + "\\n", "utf-8");
`);

  const reviewerScript = resolveReviewerScript("codex");
  const { reviewText } = loadReviewText({
    body: "# Notes\n",
    data: manifest,
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: null,
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  });

  assert.equal(JSON.parse(reviewText).verdict, "pass");
  const eventLines = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8").trim().split("\n").filter(Boolean);
  const reviewInvokeEvent = JSON.parse(eventLines.at(-1));
  assert.equal(reviewInvokeEvent.event, "review_invoke");
  assert.equal(reviewInvokeEvent.reviewer_policy.adapter, "codex");
  assert.equal(reviewInvokeEvent.reviewer_policy.phase, "primary_review");
  assert.equal(reviewInvokeEvent.reviewer_policy.read_only.enforcement_level, "native");
  assert.deepEqual(reviewInvokeEvent.reviewer_policy.read_only.flags, ["--sandbox read-only"]);
  assert.equal(reviewInvokeEvent.reviewer_policy.safe, true);
});

test("reviewer-invoke/loadReviewText denies disallowed reviewer model before adapter invocation", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath, runId } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const markerPath = path.join(helperDir, "invoked.txt");
  const reviewerScript = writeExecutable(helperDir, "reviewer-must-not-run.js", `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "invoked\\n", "utf-8");
process.stdout.write("{\\"verdict\\":\\"pass\\"}\\n");
`);

  assert.throws(() => loadReviewText({
    body: "# Notes\n",
    data: manifest,
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: "openai/gpt-5",
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  }), (error) => {
    assert.equal(error.decision.allowed, false);
    assert.equal(error.decision.phase, "review");
    assert.equal(error.decision.actor_field, "reviewer");
    assert.equal(error.decision.reviewer, "codex");
    assert.equal(error.decision.model, "openai/gpt-5");
    assert.equal(error.decision.reason, "unknown_model_route");
    assert.equal(error.adapterCapability.adapter, "custom-reviewer-script");
    assert.equal(error.adapterCapability.safe, true);
    assert.match(error.message, /phase=review/);
    assert.match(error.message, /reviewer=codex/);
    return true;
  });

  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
  const events = fs.existsSync(getEventsPath(repoRoot, runId))
    ? fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8")
    : "";
  assert.doesNotMatch(events, /review_invoke/);
});

test("reviewer-invoke precedence R4 regression: reviewer argv stays byte-identical when CLI and manifest hint are both absent", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath, runId } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeReviewerArgEchoScript(helperDir, "reviewer-r4.js");

  const { reviewText } = loadReviewText({
    body: "# Notes\n",
    data: manifest,
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: null,
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  });

  assert.deepEqual(JSON.parse(reviewText).argv, [
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ]);

  const eventLines = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8").trim().split("\n").filter(Boolean);
  const reviewInvokeEvent = JSON.parse(eventLines.at(-1));
  assert.equal(reviewInvokeEvent.event, "review_invoke");
  assert.equal(reviewInvokeEvent.model, null);
});

test("reviewer-invoke keeps managed Codex reviewer modeless despite local executor defaults", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath, runId } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;
  fs.writeFileSync(path.join(relayHome, "executors.json"), JSON.stringify({
    executors: {
      codex: { default_model: "openai/gpt-5" },
    },
  }, null, 2), "utf-8");

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeReviewerArgEchoScript(helperDir, "reviewer-codex-modeless.js");

  const { reviewText } = loadReviewText({
    body: "# Notes\n",
    data: manifest,
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: null,
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  });

  assert.deepEqual(JSON.parse(reviewText).argv, [
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ]);

  const eventLines = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8").trim().split("\n").filter(Boolean);
  const reviewInvokeEvent = JSON.parse(eventLines.at(-1));
  assert.equal(reviewInvokeEvent.event, "review_invoke");
  assert.equal(reviewInvokeEvent.model, null);
  assert.equal(reviewInvokeEvent.policy_decision.allowed, true);
  assert.equal(reviewInvokeEvent.policy_decision.reason, "managed_cli");
});

test("reviewer-invoke/loadReviewText escalates when the reviewer mutates the worktree", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath, runId } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeExecutable(helperDir, "reviewer-mutates.js", `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const repo = repoIndex !== -1 ? args[repoIndex + 1] : process.cwd();
fs.writeFileSync(path.join(repo, "mutated.txt"), "dirty\\n", "utf-8");
process.stdout.write("{\\"verdict\\":\\"pass\\"}\\n");
`);

  assert.throws(() => loadReviewText({
    body: "# Notes\n",
    data: manifest,
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: null,
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  }), /Reviewer write policy violation detected/);

  const updatedManifest = readManifest(manifestPath).data;
  const violationPath = path.join(runDir, "review-round-1-policy-violation.txt");
  const eventsPath = getEventsPath(repoRoot, runId);

  assert.equal(updatedManifest.state, STATES.ESCALATED);
  assert.equal(updatedManifest.next_action, "inspect_review_failure");
  assert.equal(updatedManifest.review.rounds, 1);
  assert.equal(updatedManifest.review.latest_verdict, "policy_violation");
  assert.equal(updatedManifest.review.last_reviewed_sha, "abc123");
  assert.equal(updatedManifest.review.last_reviewer, "codex");
  assert.match(fs.readFileSync(violationPath, "utf-8"), /mutated\.txt/);
  assert.match(fs.readFileSync(eventsPath, "utf-8"), /"reason":"policy_violation"/);
  assert.match(fs.readFileSync(eventsPath, "utf-8"), /"reviewer":"codex"/);
});

test("reviewer-invoke/captureGitStatus preserves dirty-worktree detection", () => {
  const { repoRoot } = setupReviewRun();
  fs.writeFileSync(path.join(repoRoot, "dirty.txt"), "dirty\n", "utf-8");

  assert.match(captureGitStatus(repoRoot), /dirty\.txt/);
});
