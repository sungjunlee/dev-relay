const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  updateManifestState,
  writeManifest,
  readManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { buildDefaultRelayPolicy } = require("../../../skills/relay-dispatch/scripts/relay-policy");
const { appendRunEvent, EVENTS, readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const {
  DEFAULT_ENFORCEMENT_RUBRIC,
  createEnforcementFixture,
} = require("../../relay-dispatch/scripts/test-support");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");
const { finishAdvisoryReview } = require("../../../skills/relay-review/scripts/review-runner/advisory");
const { buildAdvisoryPrompt } = require("../../../skills/relay-review/scripts/review-runner/advisory-prompt");
const { applyReviewAssurancePolicy } = require("../../../skills/relay-review/scripts/review-runner/assurance");
const { installFakeGhOnPath } = require("../fixtures/fake-gh");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "review-runner.js");
const DISPATCH_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "dispatch.js");

function installDefaultGhFixture() {
  return installFakeGhOnPath({
    body: "## Test PR\n\nFixture body.\n",
    headRefOid: "a".repeat(40),
    headRefName: "issue-429",
    statusCheckRollup: [{ name: "unit", conclusion: "SUCCESS", status: "COMPLETED" }],
  }, { prefix: "relay-review-advisory-gh-" });
}

const defaultGhFixture = installDefaultGhFixture();
test.after(() => defaultGhFixture.restore());

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function defaultRubricScores() {
  return [{
    factor: "Default enforcement rubric",
    target: ">= 1/1",
    observed: "1/1",
    status: "pass",
    tier: "contract",
    notes: "The enforcement fixture rubric remained satisfied.",
  }];
}

function passVerdict() {
  return {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  };
}

function advisoryPrompt(profile) {
  return buildAdvisoryPrompt({
    branch: "issue-844",
    diffText: "diff --git a/a.js b/a.js\n+a\n",
    doneCriteria: "# Done Criteria\n\n- Exercise advisory profile\n",
    doneCriteriaSource: "file",
    issueNumber: 844,
    prNumber: 860,
    profile,
    round: 1,
    rubricLoad: { state: "missing" },
  });
}

test("advisory prompt uses adversarial challenge framing only for the adversarial profile", () => {
  const adversarial = advisoryPrompt("adversarial");
  const blindspot = advisoryPrompt("blindspot");

  assert.match(adversarial, /find ways this change fails in production/i);
  assert.match(adversarial, /attacker and a chaos engineer/i);
  assert.match(adversarial, /edge cases, race conditions, security holes, resource leaks, and silent data corruption/i);
  assert.match(adversarial, /no compliments/i);
  assert.match(adversarial, /file:line specific/i);
  assert.match(adversarial, /required_findings exactly as the schema defines/i);
  assert.doesNotMatch(blindspot, /attacker and a chaos engineer/i);
  assert.doesNotMatch(blindspot, /no compliments/i);
});

function changesRequestedVerdict() {
  return {
    ...passVerdict(),
    verdict: "changes_requested",
    summary: "One required fix remains.",
    contract_status: "fail",
    next_action: "changes_requested",
    issues: [{
      title: "Primary required fix",
      body: "Primary reviewer requested this change.",
      file: "README.md",
      line: 1,
      category: "contract",
      severity: "high",
      confidence: "high",
    }],
  };
}

function lowConfidenceChangesRequestedVerdict() {
  return {
    ...changesRequestedVerdict(),
    summary: "Only a low-confidence concern remains.",
    contract_status: "pass",
    quality_review_status: "pass",
    issues: [{
      title: "Speculative primary concern",
      body: "This concern is intentionally low confidence.",
      file: "README.md",
      line: 1,
      category: "quality",
      severity: "low",
      confidence: "low",
    }],
  };
}

function setupRepo({
  reviewAssurance = "standard",
  strictEvidence = false,
  roles = { orchestrator: "codex", executor: "codex", reviewer: "codex" },
  modelPolicy = "allow-opencode-advisory",
} = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-advisory-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-advisory-origin-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const policyByName = {
    "allow-opencode-advisory": {
      profile: "allow-opencode-advisory",
      allowed_model_routes: [{
        route: "example/opencode-model-*",
        phases: ["advisory_review"],
        reviewers: ["opencode"],
      }, {
        route: "mirror/*",
        phases: ["review"],
        reviewers: ["mirror"],
      }],
    },
    "allow-opencode-primary": {
      profile: "allow-opencode-primary",
      allowed_model_routes: [{
        route: "example/opencode-model-*",
        phases: ["review"],
        reviewers: ["opencode"],
      }],
    },
    "allow-pi-advisory": {
      profile: "allow-pi-advisory",
      allowed_model_routes: [{
        route: "openai/*",
        phases: ["advisory_review"],
        reviewers: ["pi"],
      }, {
        route: "mirror/*",
        phases: ["review"],
        reviewers: ["mirror"],
      }],
    },
    "allow-antigravity-advisory": {
      profile: "allow-antigravity-advisory",
      allowed_model_routes: [{
        route: "google/*",
        phases: ["advisory_review"],
        reviewers: ["antigravity"],
      }, {
        route: "mirror/*",
        phases: ["review"],
        reviewers: ["mirror"],
      }],
    },
    "allow-cline-advisory": {
      profile: "allow-cline-advisory",
      allowed_model_routes: [{
        route: "cline-pass/*",
        phases: ["advisory_review"],
        reviewers: ["cline"],
      }, {
        route: "mirror/*",
        phases: ["review"],
        reviewers: ["mirror"],
      }],
    },
    "allow-multi-advisory": {
      profile: "allow-multi-advisory",
      allowed_model_routes: [{
        route: "example/opencode-model-*",
        phases: ["advisory_review"],
        reviewers: ["opencode"],
      }, {
        route: "openai/*",
        phases: ["advisory_review"],
        reviewers: ["pi"],
      }, {
        route: "mirror/*",
        phases: ["review"],
        reviewers: ["mirror"],
      }],
    },
  };
  const selectedPolicy = policyByName[modelPolicy];
  if (modelPolicy === "strict-routes") {
    fs.writeFileSync(path.join(process.env.RELAY_HOME, "routes.json"), JSON.stringify({
      version: 2,
      strict: true,
    }, null, 2), "utf-8");
  }
  if (selectedPolicy) {
    fs.writeFileSync(path.join(process.env.RELAY_HOME, "policy.json"), JSON.stringify({
      ...buildDefaultRelayPolicy(),
      profile: selectedPolicy.profile,
      managed_cli: ["codex", "claude", "mirror"],
      allowed_model_routes: selectedPolicy.allowed_model_routes,
    }, null, 2), "utf-8");
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Advisory Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const runId = "issue-429-20260505010000000";
  const worktreePath = path.join(repoRoot, "wt", "issue-429");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", "issue-429"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-429",
    baseBranch: "main",
    issueNumber: 429,
    worktreePath,
    orchestrator: roles.orchestrator,
    executor: roles.executor,
    reviewer: roles.reviewer,
    reviewAssurance,
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor = createEnforcementFixture({
    repoRoot,
    runId,
    state: "loaded",
    rubricContent: DEFAULT_ENFORCEMENT_RUBRIC,
  }).anchor;
  manifest = { ...manifest, git: { ...(manifest.git || {}), pr_number: 429, head_sha: headSha } };
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);
  fs.writeFileSync(path.join(runDir, EXECUTION_EVIDENCE_FILENAME), `${JSON.stringify({
    schema_version: 1,
    head_sha: headSha,
    test_command: "node --test",
    test_result_hash: strictEvidence ? "a".repeat(64) : "unspecified",
    test_result_summary: "pass",
    ...(strictEvidence ? { test_exit_code: 0 } : {}),
    recorded_at: "2026-05-05T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  }, null, 2)}\n`, "utf-8");
  const doneCriteriaPath = path.join(repoRoot, "done-criteria.md");
  const diffPath = path.join(repoRoot, "pr.diff");
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Add advisory lane\n", "utf-8");
  fs.writeFileSync(diffPath, "diff --git a/README.md b/README.md\n+advisory\n", "utf-8");
  return { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath };
}

function setupDispatchRepoForPresetAdvisory() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-preset-dispatch-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-preset-origin-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Preset Dispatch"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-preset@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const rubricFile = path.join(repoRoot, "rubric.yaml");
  const doneCriteriaPath = path.join(repoRoot, "done-criteria.md");
  const diffPath = path.join(repoRoot, "pr.diff");
  fs.writeFileSync(rubricFile, DEFAULT_ENFORCEMENT_RUBRIC, "utf-8");
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Route advisory preset\n", "utf-8");
  fs.writeFileSync(diffPath, "diff --git a/README.md b/README.md\n+advisory preset\n", "utf-8");
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    routes: [
      { route: "example/opencode-model-*", phases: ["advisory_review"], reviewers: ["opencode"] },
    ],
    presets: {
      diverse: {
        advisory_review: {
          reviewer: "opencode",
          model: "example/opencode-model-fast",
          profile: "blindspot",
        },
      },
    },
  });
  return { repoRoot, relayHome, rubricFile, doneCriteriaPath, diffPath };
}

function writeNoOpCodex(binDir) {
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
const output = args[args.indexOf("-o") + 1];
fs.writeFileSync(output, "preset dispatch ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writePrimaryReviewer(repoRoot, verdict, { logPath = null, delayMs = 0 } = {}) {
  const filePath = path.join(repoRoot, "primary-reviewer.js");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("fs");
const logPath = ${JSON.stringify(logPath)};
if (logPath) fs.appendFileSync(logPath, "primary-start " + Date.now() + "\\n");
setTimeout(() => {
  if (logPath) fs.appendFileSync(logPath, "primary-end " + Date.now() + "\\n");
  process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
}, ${Number(delayMs)});
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeFakeOpencode(repoRoot, { delayMs = 0, logPath = null, invalidJson = false, mutate = false, requiredFinding = false, primaryVerdict = null } = {}) {
  const filePath = path.join(repoRoot, "fake-opencode.js");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const logPath = ${JSON.stringify(logPath)};
if (logPath) fs.appendFileSync(logPath, "advisory-start " + Date.now() + "\\n");
if (${mutate ? "true" : "false"}) fs.writeFileSync(path.join(process.cwd(), "advisory-mutated.txt"), "bad\\n", "utf-8");
setTimeout(() => {
  if (${invalidJson ? "true" : "false"}) {
    process.stdout.write("not json");
  } else if (${JSON.stringify(primaryVerdict)} !== null) {
    process.stdout.write(JSON.stringify(${JSON.stringify(primaryVerdict)}));
  } else {
    process.stdout.write(JSON.stringify({
      profile: "blindspot",
      summary: "One advisory blind spot.",
      required_findings: ${requiredFinding ? `[{ title: "Required hardened fix", body: "Must fix before merge.", file: "README.md", line: 1, severity: "P2", category: "bypass", confidence: 0.9 }]` : "[]"},
      advisory_findings: [{
        title: "Advisory-only test gap",
        body: "This should be recorded but not merged into primary redispatch.",
        file: "README.md",
        line: 1,
        severity: "P3",
        category: "test-gap",
        confidence: 0.8
      }],
      duplicate_or_low_confidence: []
    }));
  }
  if (logPath) fs.appendFileSync(logPath, "advisory-end " + Date.now() + "\\n");
}, ${Number(delayMs)});
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeFakeAdvisoryCli(repoRoot, name, { delayMs = 0, logPath = null, invalidJson = false, mutate = false, requiredFinding = false } = {}) {
  const filePath = path.join(repoRoot, `fake-${name}.js`);
  const advisoryPayload = `JSON.stringify({
      profile: "blindspot",
      summary: ${JSON.stringify(`${name} advisory blind spot.`)},
      required_findings: ${requiredFinding ? `[{ title: ${JSON.stringify(`${name} required fix`)}, body: "Must fix before merge.", file: "README.md", line: 1, severity: "P2", category: "bypass", confidence: 0.9 }]` : "[]"},
      advisory_findings: [{
        title: ${JSON.stringify(`${name} advisory-only test gap`)},
        body: "This should be recorded but not merged into primary redispatch.",
        file: "README.md",
        line: 1,
        severity: "P3",
        category: "test-gap",
        confidence: 0.8
      }],
      duplicate_or_low_confidence: []
    })`;
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const logPath = ${JSON.stringify(logPath)};
if (logPath) fs.appendFileSync(logPath, "advisory-start " + Date.now() + "\\n");
if (${mutate ? "true" : "false"}) fs.writeFileSync(path.join(process.cwd(), "advisory-mutated.txt"), "bad\\n", "utf-8");
setTimeout(() => {
  if (${invalidJson ? "true" : "false"}) {
    process.stdout.write("not json");
  } else {
    const payload = ${advisoryPayload};
    if (${name === "cline" ? "true" : "false"}) {
      process.stdout.write(JSON.stringify({ type: "run_result", text: payload }) + "\\n");
    } else {
      process.stdout.write(payload);
    }
  }
  if (logPath) fs.appendFileSync(logPath, "advisory-end " + Date.now() + "\\n");
}, ${Number(delayMs)});
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function waitForEvent(repoRoot, runId, predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readRunEvents(repoRoot, runId).find(predicate);
    if (event) return event;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return null;
}

function runReview({
  repoRoot,
  runId,
  doneCriteriaPath,
  diffPath,
  primaryScript,
  opencodeScript,
  piScript = null,
  antigravityScript = null,
  clineScript = null,
  advisoryReviewer = "opencode",
  reviewer = "codex",
  extraArgs = [],
  noComment = true,
}) {
  const env = { ...process.env };
  if (opencodeScript) env.RELAY_OPENCODE_BIN = opencodeScript;
  if (piScript) env.RELAY_PI_BIN = piScript;
  if (antigravityScript) env.RELAY_ANTIGRAVITY_BIN = antigravityScript;
  if (clineScript) env.RELAY_CLINE_BIN = clineScript;
  const advisoryModelArgs = (
    advisoryReviewer === "opencode" &&
    !extraArgs.includes("--advisory-reviewer-model")
  ) ? ["--advisory-reviewer-model", "example/opencode-model-fast"] : [];
  return JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", reviewer,
    "--reviewer-script", primaryScript,
    ...(advisoryReviewer ? ["--advisory-reviewer", advisoryReviewer] : []),
    ...(noComment ? ["--no-comment"] : []),
    "--json",
    ...advisoryModelArgs,
    ...extraArgs,
  ], {
    encoding: "utf-8",
    env,
  }));
}

test("review-runner records successful opencode advisory review without gating primary pass", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const manifest = readManifest(manifestPath).data;
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "success");
  assert.equal(result.advisoryReview.advisory_count, 1);
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.ok(fs.existsSync(path.join(runDir, "review-round-1-advisory-opencode.json")));
  assert.equal(event.status, "success");
  assert.equal(event.profile, "blindspot");
  assert.equal(event.policy_decision.allowed, true);
  assert.equal(event.policy_decision.reason, "allowed_model_route");
  assert.equal(event.advisory_artifact_hash, hashFile(path.join(runDir, "review-round-1-advisory-opencode.json")));
  assert.equal(event.reviewer_policy.read_only.enforcement_level, "prompt-only");
  assert.match(event.reviewer_policy.read_only.warnings.join("\n"), /not prevent writes/i);
});

test("review-runner routed advisory unregistered route event preserves route-plan model resolution provenance", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);
  writeJson(path.join(process.env.RELAY_HOME, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    profile: "open-advisory-unregistered-test",
    deny_unknown_model_routes: false,
  });
  const modelResolution = {
    original_input: "opencode:unregistered-advisory",
    actor: "opencode",
    actor_field: "reviewer",
    phase: "advisory_review",
    requested_model: "unregistered-advisory",
    resolved_route: "openai/unregistered-advisory",
    source: "catalog_fallback",
    candidates: ["openai/unregistered-advisory"],
    warnings: ["catalog fallback used"],
  };
  writeJson(path.join(runDir, "route-plan.json"), {
    version: 1,
    phases: {
      advisory_review: {
        reviewer: "opencode",
        model: "openai/unregistered-advisory",
        profile: "blindspot",
        model_resolution: modelResolution,
      },
    },
  });
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: {
          reviewer: "opencode",
          model: "openai/unregistered-advisory",
          profile: "blindspot",
        },
      },
    },
  }, record.body);

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "30"],
  });
  const events = readRunEvents(repoRoot, runId);
  const advisoryEvent = events.find((record) => record.event === "advisory_review");
  const unregistered = events.find((record) => record.event === "unregistered_route_used");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(advisoryEvent.policy_decision.reason, "unknown_allowed");
  assert.equal(unregistered.phase, "advisory_review");
  assert.equal(unregistered.actor_field, "reviewer");
  assert.equal(unregistered.reviewer, "opencode");
  assert.equal(unregistered.model, "openai/unregistered-advisory");
  assert.equal(unregistered.model_resolution_source, "catalog_fallback");
  assert.deepEqual(unregistered.model_resolution, modelResolution);
});

test("review-runner accepts opencode primary review when route policy allows the reviewer model", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo({
    modelPolicy: "allow-opencode-primary",
    roles: { orchestrator: "codex", executor: "codex", reviewer: "opencode" },
  });
  const opencodeScript = writeFakeOpencode(repoRoot, {
    primaryVerdict: passVerdict(),
  });

  const result = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", "opencode",
    "--reviewer-model", "example/opencode-model-fast",
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_OPENCODE_BIN: opencodeScript },
  }));
  const manifest = readManifest(manifestPath).data;
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "review_invoke");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.reviewer, "opencode");
  assert.equal(result.appliedVerdict, "pass");
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.deepEqual(manifest.roles, { orchestrator: "codex", executor: "codex", reviewer: "opencode" });
  assert.equal(manifest.review.last_reviewer, "opencode");
  assert.ok(fs.existsSync(path.join(runDir, "review-round-1-verdict.json")));
  assert.equal(event.reviewer_policy.adapter, "opencode");
  assert.equal(event.reviewer_policy.phase, "primary_review");
  assert.equal(event.reviewer_policy.safe, true);
  assert.equal(event.policy_decision.allowed, true);
  assert.equal(event.policy_decision.model, "example/opencode-model-fast");
});

test("review-runner denies opencode primary review before spawning when route policy blocks the model", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "strict-routes" });
  const logPath = path.join(repoRoot, "opencode-primary-policy.log");
  const opencodeScript = writeFakeOpencode(repoRoot, {
    logPath,
    primaryVerdict: passVerdict(),
  });
  const proc = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", "opencode",
    "--reviewer-model", "example/opencode-model-fast",
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_OPENCODE_BIN: opencodeScript },
  });

  assert.notEqual(proc.status, 0);
  assert.equal(fs.existsSync(logPath), false);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.adapter_capability.adapter, "opencode");
  assert.equal(result.adapter_capability.phase, "primary_review");
  assert.equal(result.adapter_capability.safe, true);
  assert.equal(result.policy_decision.allowed, false);
  assert.equal(result.policy_decision.phase, "review");
  assert.equal(result.policy_decision.reviewer, "opencode");
  assert.equal(result.policy_decision.model, "example/opencode-model-fast");
  assert.equal(result.hint, "run relay-config to register this route");
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
});

test("review-runner prints relay-config route hint for text primary review route denial", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "strict-routes" });
  const logPath = path.join(repoRoot, "opencode-primary-policy-text.log");
  const opencodeScript = writeFakeOpencode(repoRoot, {
    logPath,
    primaryVerdict: passVerdict(),
  });
  const proc = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", "opencode",
    "--reviewer-model", "example/opencode-model-fast",
    "--no-comment",
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_OPENCODE_BIN: opencodeScript },
  });

  assert.notEqual(proc.status, 0);
  assert.equal(fs.existsSync(logPath), false);
  assert.equal(proc.stdout, "");
  assert.match(proc.stderr, /Error: relay policy denied model route.*phase=review.*reviewer=opencode.*reason=unknown_model_route/);
  assert.match(proc.stderr, /hint: run relay-config to register this route/);
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
});

test("review-runner reports relay-config default-model hint for unresolved primary reviewer model in JSON and text modes", () => {
  for (const jsonOut of [true, false]) {
    const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "strict-routes" });
    const logPath = path.join(repoRoot, `opencode-primary-missing-model-${jsonOut ? "json" : "text"}.log`);
    const opencodeScript = writeFakeOpencode(repoRoot, {
      logPath,
      primaryVerdict: passVerdict(),
    });
    const args = [
      SCRIPT,
      "--repo", repoRoot,
      "--run-id", runId,
      "--pr", "429",
      "--done-criteria-file", doneCriteriaPath,
      "--diff-file", diffPath,
      "--reviewer", "opencode",
      "--no-comment",
    ];
    if (jsonOut) args.push("--json");

    const proc = spawnSync("node", args, {
      encoding: "utf-8",
      env: { ...process.env, RELAY_OPENCODE_BIN: opencodeScript },
    });

    assert.notEqual(proc.status, 0);
    assert.equal(fs.existsSync(logPath), false);
    assert.match(proc.stderr, /Error: relay policy denied model route.*phase=review.*reviewer=opencode.*reason=missing_model_route/);
    assert.match(proc.stderr, /hint: run relay-config to set a default model for this route/);
    assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
    if (jsonOut) {
      const result = JSON.parse(proc.stdout);
      assert.equal(result.status, "failed");
      assert.equal(result.policy_decision.reason, "missing_model_route");
      assert.equal(result.policy_decision.model, null);
      assert.equal(result.hint, "run relay-config to set a default model for this route");
    } else {
      assert.equal(proc.stdout, "");
    }
  }
});

test("review-runner reports install hint when primary reviewer CLI is missing in JSON and text modes", () => {
  for (const jsonOut of [true, false]) {
    const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo({
      modelPolicy: "allow-opencode-primary",
      roles: { orchestrator: "codex", executor: "codex", reviewer: "opencode" },
    });
    const args = [
      SCRIPT,
      "--repo", repoRoot,
      "--run-id", runId,
      "--pr", "429",
      "--done-criteria-file", doneCriteriaPath,
      "--diff-file", diffPath,
      "--reviewer", "opencode",
      "--reviewer-model", "example/opencode-model-fast",
      "--no-comment",
    ];
    if (jsonOut) args.push("--json");

    const proc = spawnSync("node", args, {
      encoding: "utf-8",
      env: { ...process.env, RELAY_OPENCODE_BIN: path.join(repoRoot, "missing-opencode") },
    });

    assert.notEqual(proc.status, 0);
    assert.match(proc.stderr, /Error: .*opencode.*ENOENT/s);
    assert.match(proc.stderr, /hint: install the opencode CLI and ensure it is on PATH/);
    if (jsonOut) {
      const result = JSON.parse(proc.stdout);
      assert.equal(result.status, "failed");
      assert.match(result.error, /opencode.*ENOENT/s);
      assert.equal(result.hint, "install the opencode CLI and ensure it is on PATH");
    } else {
      assert.equal(proc.stdout, "");
    }
  }
});

test("review-runner uses manifest routing advisory defaults without changing the primary reviewer", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: { reviewer: "opencode", model: "example/opencode-model-fast", profile: "blindspot" },
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
  });
  const manifest = readManifest(manifestPath).data;

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.reviewer, "codex");
  assert.equal(result.advisoryReview.reviewer, "opencode");
  assert.equal(result.advisoryReview.source, "routing");
  assert.equal(manifest.review.last_reviewer, "codex");
  assert.deepEqual(manifest.roles, { orchestrator: "codex", executor: "codex", reviewer: "codex" });
});

test("review-runner fans out manifest advisory lane list and avoids duplicate reviewer artifact collisions", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo({
    modelPolicy: "allow-multi-advisory",
  });
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", profile: "blindspot" },
          { reviewer: "opencode", model: "example/opencode-model-fast", profile: "blindspot" },
        ],
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "30"],
  });
  const events = readRunEvents(repoRoot, runId).filter((record) => record.event === EVENTS.ADVISORY_REVIEW);

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReviews.length, 2);
  assert.deepEqual(result.advisoryReviews.map((entry) => entry.reviewer), ["opencode", "opencode"]);
  assert.ok(fs.existsSync(path.join(runDir, "review-round-1-advisory-opencode.json")));
  assert.ok(fs.existsSync(path.join(runDir, "review-round-1-advisory-opencode-lane2.json")));
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.trigger), ["every_round", "every_round"]);
  assert.deepEqual(events.map((event) => event.gating), [false, false]);
});

test("review-runner validates all advisory lanes before starting any advisory worker", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", profile: "blindspot" },
          { reviewer: "pi", model: "openai/gpt-5", profile: "blindspot" },
        ],
      },
    },
  }, record.body);
  const opencodeLog = path.join(repoRoot, "opencode-advisory-preflight.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { logPath: opencodeLog });
  const piScript = writeFakeAdvisoryCli(repoRoot, "pi");

  const proc = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", "codex",
    "--reviewer-script", primaryScript,
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_OPENCODE_BIN: opencodeScript,
      RELAY_PI_BIN: piScript,
    },
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  const advisoryFiles = fs.readdirSync(runDir)
    .filter((name) => name.includes("advisory-opencode"))
    .sort();
  const advisoryEvents = readRunEvents(repoRoot, runId)
    .filter((record) => record.event === EVENTS.ADVISORY_REVIEW);

  assert.equal(result.status, "failed");
  assert.equal(result.policy_decision.allowed, false);
  assert.equal(result.policy_decision.phase, "advisory_review");
  assert.equal(result.policy_decision.reviewer, "pi");
  assert.equal(result.policy_decision.model, "openai/gpt-5");
  assert.deepEqual(advisoryFiles, []);
  assert.equal(fs.existsSync(path.join(runDir, "advisory-worktrees")), false);
  assert.equal(fs.existsSync(opencodeLog), false);
  assert.deepEqual(advisoryEvents, []);
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
});

test("review-runner validates on_pass advisory lanes before starting every_round workers", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", profile: "blindspot", trigger: "every_round" },
          { reviewer: "pi", model: "openai/gpt-5", profile: "blindspot", trigger: "on_pass" },
        ],
      },
    },
  }, record.body);
  const opencodeLog = path.join(repoRoot, "opencode-on-pass-preflight.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { logPath: opencodeLog });
  const piScript = writeFakeAdvisoryCli(repoRoot, "pi");

  const proc = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", "codex",
    "--reviewer-script", primaryScript,
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_OPENCODE_BIN: opencodeScript,
      RELAY_PI_BIN: piScript,
    },
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  const advisoryFiles = fs.readdirSync(runDir)
    .filter((name) => name.includes("advisory-opencode"))
    .sort();
  const advisoryEvents = readRunEvents(repoRoot, runId)
    .filter((record) => record.event === EVENTS.ADVISORY_REVIEW);

  assert.equal(result.status, "failed");
  assert.equal(result.policy_decision.allowed, false);
  assert.equal(result.policy_decision.phase, "advisory_review");
  assert.equal(result.policy_decision.reviewer, "pi");
  assert.equal(result.policy_decision.model, "openai/gpt-5");
  assert.deepEqual(advisoryFiles, []);
  assert.equal(fs.existsSync(path.join(runDir, "advisory-worktrees")), false);
  assert.equal(fs.existsSync(opencodeLog), false);
  assert.deepEqual(advisoryEvents, []);
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
});

test("preset-only dispatch starts advisory review through manifest routing selection", () => {
  const { repoRoot, relayHome, rubricFile, doneCriteriaPath, diffPath } = setupDispatchRepoForPresetAdvisory();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-preset-bin-"));
  writeNoOpCodex(binDir);

  const dispatch = spawnSync(process.execPath, [
    DISPATCH_SCRIPT,
    repoRoot,
    "-b",
    "issue-preset-advisory",
    "-p",
    "dispatch with diverse route preset",
    "--rubric-file",
    rubricFile,
    "--route-preset",
    "diverse",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  });
  assert.equal(dispatch.status, 0, dispatch.stderr);
  const dispatchOutput = JSON.parse(dispatch.stdout);
  const manifest = readManifest(dispatchOutput.manifestPath).data;
  assert.deepEqual(manifest.routing.selected.advisory_review, [{
    reviewer: "opencode",
    model: "example/opencode-model-fast",
    profile: "blindspot",
    trigger: "every_round",
    gating: false,
  }]);

  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);
  const result = runReview({
    repoRoot,
    runId: dispatchOutput.runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "30"],
  });

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.reviewer, "opencode");
  assert.equal(result.advisoryReview.source, "routing");
});

test("review-runner denies disallowed advisory model before spawning advisory reviewer", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "strict-routes" });
  const logPath = path.join(repoRoot, "advisory-policy.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { logPath });

  assert.throws(
    () => runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript }),
    /phase=advisory_review.*reviewer=opencode|reviewer=opencode.*phase=advisory_review/
  );
  assert.equal(fs.existsSync(logPath), false);
});

test("review-runner accepts pi advisory review when route policy allows the reviewer model", () => {
  const { repoRoot, runDir, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "allow-pi-advisory" });
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const piScript = writeFakeAdvisoryCli(repoRoot, "pi");

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript: null,
    piScript,
    advisoryReviewer: "pi",
    // This test asserts the advisory pipeline completes successfully, not
    // grace-window boundary behavior (that is covered separately by the
    // dedicated "...applies the primary verdict after advisory grace..." and
    // "...when advisory times out during grace" tests, which use deliberate
    // delayMs values well past their own short --advisory-grace/--advisory-timeout).
    // review-runner.js's standard-mode settleAdvisoryForVerdict polls for the
    // advisory result for only DEFAULT_ADVISORY_GRACE_SECONDS (10s) when this
    // flag is not passed. Completing requires a chain of real subprocess
    // spawns (detached advisory-worker node process -> `git worktree add` ->
    // the fake pi reviewer node process -> a file-based round trip back to
    // this process before the event is appended). Under full-suite parallel
    // load (many files forking subprocesses concurrently), that chain can
    // occasionally take longer than 10s of wall clock even though every step
    // does effectively no work (#759). Pass a generous grace so polling has
    // real headroom to observe completion under contention.
    extraArgs: ["--advisory-reviewer-model", "openai/gpt-5", "--advisory-grace", "30"],
  });
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "success");
  assert.equal(result.advisoryReview.reviewer, "pi");
  assert.ok(fs.existsSync(path.join(runDir, "review-round-1-advisory-pi.json")));
  assert.equal(event.reviewer, "pi");
  assert.equal(event.policy_decision.allowed, true);
  assert.equal(event.policy_decision.model, "openai/gpt-5");
  assert.equal(event.reviewer_policy.adapter, "pi");
  assert.equal(event.reviewer_policy.phase, "advisory_review");
  assert.equal(event.reviewer_policy.safe, true);
});

test("review-runner accepts antigravity advisory review when route policy allows the reviewer model", () => {
  const { repoRoot, runDir, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "allow-antigravity-advisory" });
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const antigravityScript = writeFakeAdvisoryCli(repoRoot, "antigravity");

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript: null,
    antigravityScript,
    advisoryReviewer: "antigravity",
    extraArgs: ["--advisory-reviewer-model", "google/antigravity-cli"],
  });
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "success");
  assert.equal(result.advisoryReview.reviewer, "antigravity");
  assert.ok(fs.existsSync(path.join(runDir, "review-round-1-advisory-antigravity.json")));
  assert.equal(event.reviewer, "antigravity");
  assert.equal(event.policy_decision.allowed, true);
  assert.equal(event.policy_decision.model, "google/antigravity-cli");
  assert.equal(event.reviewer_policy.adapter, "antigravity");
  assert.equal(event.reviewer_policy.phase, "advisory_review");
  assert.equal(event.reviewer_policy.safe, true);
});

test("review-runner accepts cline advisory review when route policy allows the reviewer model", () => {
  const { repoRoot, runDir, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "allow-cline-advisory" });
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const clineScript = writeFakeAdvisoryCli(repoRoot, "cline");

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript: null,
    clineScript,
    advisoryReviewer: "cline",
    extraArgs: ["--advisory-reviewer-model", "cline-pass/glm-5.2", "--advisory-grace", "30"],
  });
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "success");
  assert.equal(result.advisoryReview.reviewer, "cline");
  assert.ok(fs.existsSync(path.join(runDir, "review-round-1-advisory-cline.json")));
  assert.equal(event.reviewer, "cline");
  assert.equal(event.policy_decision.allowed, true);
  assert.equal(event.policy_decision.model, "cline-pass/glm-5.2");
  assert.equal(event.reviewer_policy.adapter, "cline");
  assert.equal(event.reviewer_policy.phase, "advisory_review");
  assert.equal(event.reviewer_policy.read_only.enforcement_level, "prompt-only");
});

test("review-runner denies pi advisory model before spawning advisory reviewer", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "strict-routes" });
  const logPath = path.join(repoRoot, "pi-advisory-policy.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const piScript = writeFakeAdvisoryCli(repoRoot, "pi", { logPath });

  const proc = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", "codex",
    "--reviewer-script", primaryScript,
    "--advisory-reviewer", "pi",
    "--advisory-reviewer-model", "openai/gpt-5",
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_PI_BIN: piScript },
  });

  assert.notEqual(proc.status, 0);
  assert.equal(fs.existsSync(logPath), false);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.adapter_capability.adapter, "pi");
  assert.equal(result.adapter_capability.phase, "advisory_review");
  assert.equal(result.adapter_capability.safe, true);
  assert.equal(result.policy_decision.allowed, false);
  assert.equal(result.policy_decision.phase, "advisory_review");
  assert.equal(result.policy_decision.reviewer, "pi");
  assert.equal(result.policy_decision.model, "openai/gpt-5");
});

test("review-runner denies antigravity advisory model before spawning advisory reviewer", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "strict-routes" });
  const logPath = path.join(repoRoot, "antigravity-advisory-policy.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const antigravityScript = writeFakeAdvisoryCli(repoRoot, "antigravity", { logPath });

  const proc = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", "codex",
    "--reviewer-script", primaryScript,
    "--advisory-reviewer", "antigravity",
    "--advisory-reviewer-model", "google/antigravity-cli",
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_ANTIGRAVITY_BIN: antigravityScript },
  });

  assert.notEqual(proc.status, 0);
  assert.equal(fs.existsSync(logPath), false);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.adapter_capability.adapter, "antigravity");
  assert.equal(result.adapter_capability.phase, "advisory_review");
  assert.equal(result.adapter_capability.safe, true);
  assert.equal(result.policy_decision.allowed, false);
  assert.equal(result.policy_decision.phase, "advisory_review");
  assert.equal(result.policy_decision.reviewer, "antigravity");
  assert.equal(result.policy_decision.model, "google/antigravity-cli");
});

test("prepare-only with advisory flags writes only the primary prompt bundle", () => {
  const { repoRoot, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();

  const result = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--advisory-reviewer", "opencode",
    "--prepare-only",
    "--json",
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_OPENCODE_BIN: path.join(repoRoot, "missing-opencode") },
  }));

  assert.equal(result.prepareOnly, true);
  assert.equal(result.advisoryReview, undefined);
  assert.equal(fs.existsSync(path.join(runDir, "review-round-1-advisory-opencode-prompt.md")), false);
  assert.equal(fs.existsSync(path.join(runDir, "advisory-worktrees")), false);
  assert.equal(readRunEvents(repoRoot, runId).some((record) => record.event === "advisory_review"), false);
});

test("advisory review is scheduled before the primary reviewer completes", () => {
  const { repoRoot, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const logPath = path.join(repoRoot, "review-order.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict(), { logPath, delayMs: 1500 });
  const opencodeScript = writeFakeOpencode(repoRoot, { logPath });

  runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const lines = fs.readFileSync(logPath, "utf-8").trim().split(/\n/);
  const primaryEnd = Number(lines.find((line) => line.startsWith("primary-end")).split(" ")[1]);
  const request = JSON.parse(fs.readFileSync(
    path.join(runDir, "review-round-1-advisory-opencode-request.json"),
    "utf-8"
  ));

  assert.ok(lines.some((line) => line.startsWith("primary-end")));
  assert.ok(request.startedAt < primaryEnd);
});

test("on_pass advisory lane starts after an applied primary pass", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "on_pass" },
        ],
      },
    },
  }, record.body);
  const logPath = path.join(repoRoot, "on-pass-order.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict(), { logPath, delayMs: 300 });
  const opencodeScript = writeFakeOpencode(repoRoot, { logPath });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "30"],
  });
  const lines = fs.readFileSync(logPath, "utf-8").trim().split(/\n/);
  const primaryEnd = Number(lines.find((line) => line.startsWith("primary-end")).split(" ")[1]);
  const advisoryStart = Number(lines.find((line) => line.startsWith("advisory-start")).split(" ")[1]);
  const request = JSON.parse(fs.readFileSync(
    path.join(runDir, "review-round-1-advisory-opencode-request.json"),
    "utf-8"
  ));

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReviews[0].trigger, "on_pass");
  assert.ok(advisoryStart >= primaryEnd);
  assert.ok(request.startedAt >= primaryEnd);
});

test("on_pass advisory lane gets its own settlement deadline after a slow primary", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "on_pass" },
        ],
      },
    },
  }, record.body);
  // Primary takes longer than the whole advisory timeout+grace budget, so a
  // deadline computed at round start is already exhausted when the on_pass
  // lane spawns. The lane must still be settled from its own fresh deadline.
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict(), { delayMs: 3000 });
  const opencodeScript = writeFakeOpencode(repoRoot, {});

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-timeout", "1", "--advisory-grace", "1"],
  });

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReviews[0].trigger, "on_pass");
  assert.equal(result.advisoryReviews[0].status, "success");
});

test("on_pass advisory lane can demote a low-confidence downgraded primary pass", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "on_pass", gating: true },
        ],
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, lowConfidenceChangesRequestedVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { requiredFinding: true });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "30"],
  });
  const manifest = readManifest(manifestPath).data;
  const events = readRunEvents(repoRoot, runId);
  const advisoryEvents = events.filter((record) => record.event === EVENTS.ADVISORY_REVIEW);
  const reviewApply = events.find((record) => record.event === EVENTS.REVIEW_APPLY);
  const verdict = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));

  assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
  assert.equal(result.advisoryReviews.length, 1);
  assert.equal(result.advisoryReviews[0].trigger, "on_pass");
  assert.equal(result.advisoryReviews[0].status, "success");
  assert.equal(advisoryEvents.length, 1);
  assert.equal(advisoryEvents[0].trigger, "on_pass");
  assert.equal(manifest.review.lane_demotions, 1);
  assert.equal(reviewApply.reason, "changes_requested");
  assert.equal(reviewApply.confidence_downgrade, true);
  assert.equal(reviewApply.low_confidence_count, 1);
  assert.equal(reviewApply.lane_demotion_cap, 2);
  assert.equal(reviewApply.lane_demotion_count, 1);
  assert.match(verdict.summary, /gating advisory lane/i);
});

test("hardened on_pass-only advisory lane starts before full missing-advisory gate", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
    reviewAssurance: "hardened",
    strictEvidence: true,
  });
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "on_pass" },
        ],
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-timeout", "30"],
  });
  const events = readRunEvents(repoRoot, runId).filter((record) => record.event === EVENTS.ADVISORY_REVIEW);

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReviews.length, 1);
  assert.equal(result.advisoryReviews[0].status, "success");
  assert.equal(result.advisoryReviews[0].trigger, "on_pass");
  assert.equal(events.length, 1);
  assert.equal(events[0].trigger, "on_pass");
});

test("on_pass advisory lane is not started when applied primary verdict requests changes", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "on_pass" },
        ],
      },
    },
  }, record.body);
  const logPath = path.join(repoRoot, "on-pass-skip.log");
  const primaryScript = writePrimaryReviewer(repoRoot, changesRequestedVerdict(), { logPath });
  const opencodeScript = writeFakeOpencode(repoRoot, { logPath });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
  });
  const lines = fs.readFileSync(logPath, "utf-8").trim().split(/\n/);

  assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
  assert.deepEqual(result.advisoryReviews, []);
  assert.equal(lines.some((line) => line.startsWith("advisory-start")), false);
  assert.equal(fs.existsSync(path.join(runDir, "review-round-1-advisory-opencode-request.json")), false);
  assert.equal(readRunEvents(repoRoot, runId).some((record) => record.event === EVENTS.ADVISORY_REVIEW), false);
});

test("no-lane standard review preserves low-confidence applied-pass artifact shape", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, lowConfidenceChangesRequestedVerdict());

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    advisoryReviewer: null,
  });
  const manifest = readManifest(manifestPath).data;
  const verdictRecord = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));
  const reviewApply = readRunEvents(repoRoot, runId).find((record) => record.event === EVENTS.REVIEW_APPLY);

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.appliedVerdict, "pass");
  assert.deepEqual(result.confidenceDowngrade, {
    originalVerdict: "changes_requested",
    appliedVerdict: "pass",
    lowConfidenceCount: 1,
  });
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(verdictRecord.verdict, "changes_requested");
  assert.equal(verdictRecord.applied_verdict, "pass");
  assert.equal(verdictRecord.issues[0].confidence, "low");
  assert.equal(reviewApply.reason, "pass");
  assert.equal(reviewApply.confidence_downgrade, true);
  assert.equal(reviewApply.low_confidence_count, 1);
});

test("on_pass advisory lane is not started after every_round gating demotes pass", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "every_round", gating: true },
          { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "on_pass" },
        ],
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { requiredFinding: true });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "30"],
  });
  const events = readRunEvents(repoRoot, runId).filter((record) => record.event === EVENTS.ADVISORY_REVIEW);

  assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
  assert.equal(result.advisoryReviews.length, 1);
  assert.equal(result.advisoryReviews[0].trigger, "every_round");
  assert.equal(events.length, 1);
  assert.equal(events[0].trigger, "every_round");
  assert.equal(fs.existsSync(path.join(runDir, "review-round-1-advisory-opencode-lane2-request.json")), false);
});

test("multiple on_pass advisory lanes share one remaining grace budget", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "on_pass" },
          { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "on_pass" },
        ],
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { delayMs: 2000 });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "0.25"],
  });
  const waits = result.advisoryReviews.map((entry) => Number(entry.criticalPathWaitMs || 0));

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.deepEqual(result.advisoryReviews.map((entry) => entry.status), ["deferred", "deferred"]);
  assert.ok(waits.reduce((sum, value) => sum + value, 0) < 400, `expected shared wait budget, got waits ${waits.join(", ")}`);
});

test("standard review applies the primary verdict after advisory grace and records late advisory as metrics-only", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { delayMs: 3000 });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    extraArgs: ["--advisory-grace", "0.05"],
  });

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "deferred");

  const event = waitForEvent(repoRoot, runId, (record) => record.event === "advisory_review", { timeoutMs: 7000 });
  assert.ok(event, "late advisory event should be attached to the run");
  assert.equal(event.status, "success");
  assert.equal(event.consumed_by_phase, "metrics");
  assert.equal(event.phase_decision_waited, true);
  assert.equal(event.frontier_step_replaced, false);
  assert.ok(event.elapsed_ms >= 3000);
  assert.ok(event.critical_path_wait_ms <= 75);
});

test("standard review applies the primary verdict when advisory times out during grace", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { delayMs: 1500 });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    extraArgs: ["--advisory-timeout", "1", "--advisory-grace", "2"],
  });
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "timeout");
  assert.match(result.advisoryReview.failureReason, /reviewer advisory_review timed out after 1s/);
  assert.equal(event.status, "timeout");
  assert.equal(event.consumed_by_phase, "review");
});

test("hardened advisory finish does not expose success before event provenance is written", async () => {
  const { repoRoot, manifestPath, runDir, runId } = setupRepo({
    reviewAssurance: "hardened",
    strictEvidence: true,
  });
  const manifest = readManifest(manifestPath).data;
  const artifactPath = path.join(runDir, "review-round-1-advisory-opencode.json");
  const resultPath = path.join(runDir, "review-round-1-advisory-opencode-result.json");
  fs.writeFileSync(artifactPath, `${JSON.stringify({
    profile: "blindspot",
    summary: "No required findings.",
    required_findings: [],
    advisory_findings: [{
      title: "Advisory note",
      body: "Recorded after the primary path.",
      file: "README.md",
      line: 1,
      severity: "P3",
      category: "test-gap",
      confidence: 0.8,
    }],
    duplicate_or_low_confidence: [],
  }, null, 2)}\n`, "utf-8");
  const result = {
    artifactHash: hashFile(artifactPath),
    artifactPath,
    advisory_count: 1,
    duplicate_low_confidence_count: 0,
    failureReason: null,
    profile: "blindspot",
    rawResponsePath: null,
    required_count: 0,
    reviewer: "opencode",
    status: "success",
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");

  const advisoryRun = {
    headSha: manifest.git.head_sha,
    profile: "blindspot",
    resultPath,
    reviewerName: "opencode",
    round: 1,
    runId,
    runRepoPath: repoRoot,
    startedAt: Date.now(),
  };
  const unbound = await finishAdvisoryReview({
    advisoryRun,
    requireEventBoundSuccess: true,
    waitMs: 0,
  });

  assert.equal(unbound.status, "failed");
  assert.match(unbound.failureReason, /not bound to a successful advisory_review event/);

  appendRunEvent(repoRoot, runId, {
    event: EVENTS.ADVISORY_REVIEW,
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.REVIEW_PENDING,
    head_sha: manifest.git.head_sha,
    round: 1,
    reviewer: "opencode",
    profile: "blindspot",
    status: "success",
    artifact_path: artifactPath,
    advisory_artifact_hash: result.artifactHash,
    raw_response_path: null,
    failure_reason: null,
    required_count: 0,
    advisory_count: 1,
    duplicate_low_confidence_count: 0,
  });
  const bound = await finishAdvisoryReview({
    advisoryRun,
    requireEventBoundSuccess: true,
    waitMs: 0,
  });

  assert.equal(bound.status, "success");
});

test("hardened advisory finish binds cached success when result rewrite lands after deadline", async () => {
  const { repoRoot, manifestPath, runDir, runId } = setupRepo({
    reviewAssurance: "hardened",
    strictEvidence: true,
  });
  const manifest = readManifest(manifestPath).data;
  const artifactPath = path.join(runDir, "review-round-1-advisory-opencode.json");
  const resultPath = path.join(runDir, "review-round-1-advisory-opencode-result.json");
  fs.writeFileSync(artifactPath, `${JSON.stringify({
    profile: "blindspot",
    summary: "No required findings.",
    required_findings: [],
    advisory_findings: [{
      title: "Advisory note",
      body: "Recorded after the primary path.",
      file: "README.md",
      line: 1,
      severity: "P3",
      category: "test-gap",
      confidence: 0.8,
    }],
    duplicate_or_low_confidence: [],
  }, null, 2)}\n`, "utf-8");
  const result = {
    artifactHash: hashFile(artifactPath),
    artifactPath,
    advisory_count: 1,
    duplicate_low_confidence_count: 0,
    failureReason: null,
    profile: "blindspot",
    rawResponsePath: null,
    required_count: 0,
    reviewer: "opencode",
    status: "success",
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  const resultDeadlineMs = Date.now() - 10;
  const oldTime = new Date(resultDeadlineMs - 100);
  fs.utimesSync(resultPath, oldTime, oldTime);

  const advisoryRun = {
    headSha: manifest.git.head_sha,
    profile: "blindspot",
    resultPath,
    reviewerName: "opencode",
    round: 1,
    runId,
    runRepoPath: repoRoot,
    startedAt: Date.now(),
  };
  const finishPromise = finishAdvisoryReview({
    advisoryRun,
    requireEventBoundSuccess: true,
    resultDeadlineMs,
    waitMs: 250,
  });
  setTimeout(() => {
    appendRunEvent(repoRoot, runId, {
      event: EVENTS.ADVISORY_REVIEW,
      state_from: STATES.REVIEW_PENDING,
      state_to: STATES.REVIEW_PENDING,
      head_sha: manifest.git.head_sha,
      round: 1,
      reviewer: "opencode",
      profile: "blindspot",
      status: "success",
      artifact_path: artifactPath,
      advisory_artifact_hash: result.artifactHash,
      raw_response_path: null,
      failure_reason: null,
      required_count: 0,
      advisory_count: 1,
      duplicate_low_confidence_count: 0,
    });
    fs.writeFileSync(resultPath, `${JSON.stringify({
      ...result,
      consumedByPhase: "review",
      criticalPathWaitMs: 25,
      elapsedMs: 25,
      phaseDecisionWaited: true,
    }, null, 2)}\n`, "utf-8");
  }, 25);

  const bound = await finishPromise;

  assert.equal(bound.status, "success");
  assert.equal(bound.artifactHash, result.artifactHash);
});

test("result rewritten after the deadline is still consumed when completed_at is within it", async () => {
  const { repoRoot, manifestPath, runDir, runId } = setupRepo();
  const manifest = readManifest(manifestPath).data;
  const resultPath = path.join(runDir, "review-round-1-advisory-opencode-result.json");
  const resultDeadlineMs = Date.now() + 60_000;
  // Simulate the worker's post-event rewrite: content completed within the
  // deadline, but the file's mtime is after it. No earlier read has cached
  // the result, so only the content stamp can rescue it.
  fs.writeFileSync(resultPath, `${JSON.stringify({
    artifactHash: null,
    artifactPath: null,
    completed_at: new Date(resultDeadlineMs - 30_000).toISOString(),
    failureReason: null,
    profile: "blindspot",
    rawResponsePath: null,
    required_count: 0,
    advisory_count: 0,
    duplicate_low_confidence_count: 0,
    reviewer: "opencode",
    status: "success",
  }, null, 2)}\n`, "utf-8");
  const lateTime = new Date(resultDeadlineMs + 120_000);
  fs.utimesSync(resultPath, lateTime, lateTime);

  const consumed = await finishAdvisoryReview({
    advisoryRun: {
      headSha: manifest.git.head_sha,
      profile: "blindspot",
      resultPath,
      reviewerName: "opencode",
      round: 1,
      runId,
      runRepoPath: repoRoot,
      startedAt: Date.now(),
    },
    resultDeadlineMs,
    waitMs: 0,
  });

  assert.equal(consumed.status, "success");
});

test("result whose completed_at is after the deadline is deferred, not consumed", async () => {
  const { repoRoot, manifestPath, runDir, runId } = setupRepo();
  const manifest = readManifest(manifestPath).data;
  const resultPath = path.join(runDir, "review-round-1-advisory-opencode-result.json");
  const resultDeadlineMs = Date.now() - 10;
  fs.writeFileSync(resultPath, `${JSON.stringify({
    artifactHash: null,
    artifactPath: null,
    completed_at: new Date(resultDeadlineMs + 30_000).toISOString(),
    failureReason: null,
    profile: "blindspot",
    rawResponsePath: null,
    required_count: 0,
    advisory_count: 0,
    duplicate_low_confidence_count: 0,
    reviewer: "opencode",
    status: "success",
  }, null, 2)}\n`, "utf-8");

  const deferred = await finishAdvisoryReview({
    advisoryRun: {
      headSha: manifest.git.head_sha,
      profile: "blindspot",
      resultPath,
      reviewerName: "opencode",
      round: 1,
      runId,
      runRepoPath: repoRoot,
      startedAt: Date.now(),
    },
    resultDeadlineMs,
    waitMs: 0,
  });

  assert.equal(deferred.status, "deferred");
});

test("invalid advisory JSON is recorded as advisory failure while primary pass still applies", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { invalidJson: true });

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "failed");
  assert.match(result.advisoryReview.failureReason, /valid JSON|exited with code 1/);
  assert.equal(event.status, "failed");
});

test("standard gating lane infrastructure failure is surfaced in JSON, event, and posted comment without demotion", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", gating: true },
        ],
      },
    },
  }, record.body);
  const commentPath = path.join(repoRoot, "posted-comment.md");
  const ghFixture = installFakeGhOnPath({
    body: "## Test PR\n\nFixture body.\n",
    headRefOid: "a".repeat(40),
    headRefName: "issue-429",
    statusCheckRollup: [{ name: "unit", conclusion: "SUCCESS", status: "COMPLETED" }],
  }, { prefix: "relay-review-advisory-warning-gh-", capturePath: commentPath });
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { invalidJson: true });

  try {
    const result = runReview({
      repoRoot,
      runId,
      doneCriteriaPath,
      diffPath,
      primaryScript,
      opencodeScript,
      advisoryReviewer: null,
      noComment: false,
    });
    const event = readRunEvents(repoRoot, runId).find((record) => record.event === EVENTS.ADVISORY_REVIEW);
    const comment = fs.readFileSync(commentPath, "utf-8");

    assert.equal(result.nextState, STATES.READY_TO_MERGE);
    assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
    assert.match(result.advisoryWarnings.join("\n"), /Advisory review warning.*opencode/i);
    assert.equal(event.status, "failed");
    assert.equal(event.gating, true);
    assert.match(event.failure_reason, /valid JSON|exited with code 1/);
    assert.match(comment, /Advisory review warning.*opencode/i);
  } finally {
    ghFixture.restore();
  }
});

test("gating lane demotes a pass produced by low-confidence primary downgrade", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", gating: true },
        ],
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, lowConfidenceChangesRequestedVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { requiredFinding: true });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "30"],
  });
  const reviewApply = readRunEvents(repoRoot, runId).find((record) => record.event === EVENTS.REVIEW_APPLY);
  const verdict = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));

  assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
  assert.deepEqual(result.confidenceDowngrade, {
    originalVerdict: "changes_requested",
    appliedVerdict: "changes_requested",
    lowConfidenceCount: 1,
  });
  assert.equal(reviewApply.confidence_downgrade, true);
  assert.equal(reviewApply.low_confidence_count, 1);
  assert.match(verdict.summary, /gating advisory lane/i);
  assert.equal(verdict.issues[0].confidence, "high");
});

test("persisted lane demotion cap escalates the third lane-driven demotion", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    review: {
      ...(record.data.review || {}),
      lane_demotions: 2,
    },
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", gating: true },
        ],
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { requiredFinding: true });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "30"],
  });
  const manifest = readManifest(manifestPath).data;
  const verdict = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));

  assert.equal(result.nextState, STATES.ESCALATED);
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.review.lane_demotions, 2);
  assert.match(verdict.summary, /demotion cap/i);
  assert.match(manifest.review.last_escalation_decision.reason, /lane_demotion_cap/);
});

test("persisted lane demotion cap escalates the third hardened lane failure", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
    reviewAssurance: "hardened",
    strictEvidence: true,
  });
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    review: {
      ...(record.data.review || {}),
      lane_demotions: 2,
    },
    routing: {
      version: 1,
      selected: {
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast" },
        ],
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { invalidJson: true });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
    extraArgs: ["--advisory-grace", "30"],
  });
  const manifest = readManifest(manifestPath).data;
  const reviewApply = readRunEvents(repoRoot, runId).find((record) => record.event === EVENTS.REVIEW_APPLY);
  const verdict = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));

  assert.equal(result.nextState, STATES.ESCALATED);
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.review.lane_demotions, 2);
  assert.equal(reviewApply.reason, "escalated");
  assert.equal(reviewApply.lane_demotion_cap, 2);
  assert.equal(reviewApply.lane_demotion_count, 2);
  assert.match(verdict.summary, /demotion cap/i);
  assert.match(verdict.issues[0].body, /Lane-driven demotion reason: Hardened advisory review did not complete successfully/);
  assert.match(manifest.review.last_escalation_decision.reason, /lane_demotion_cap/);
});

test("advisory worktree mutation is captured without escalating the manifest", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { mutate: true });

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "policy_violation");
  assert.match(event.artifact_path, /policy-violation\.txt$/);
});

test("advisory findings do not alter primary redispatch output", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, changesRequestedVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const redispatch = fs.readFileSync(result.redispatchPath, "utf-8");

  assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
  assert.match(redispatch, /Primary required fix/);
  assert.doesNotMatch(redispatch, /Advisory-only test gap/);
});

test("hardened review assurance blocks a primary pass without advisory evidence", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
    reviewAssurance: "hardened",
    strictEvidence: true,
  });
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());

  assert.throws(
    () => execFileSync("node", [
      SCRIPT,
      "--repo", repoRoot,
      "--run-id", runId,
      "--pr", "429",
      "--done-criteria-file", doneCriteriaPath,
      "--diff-file", diffPath,
      "--reviewer", "codex",
      "--reviewer-script", primaryScript,
      "--no-comment",
      "--json",
    ], { encoding: "utf-8" }),
    /policy\.review_assurance=hardened requires --advisory-reviewer/
  );

  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
});

test("hardened assurance is generic for Codex-only and non-Codex role bindings", async (t) => {
  for (const entry of [
    {
      label: "codex-only",
      roles: { orchestrator: "codex", executor: "codex", reviewer: "codex" },
      reviewer: "codex",
    },
    {
      label: "non-codex-fixture",
      roles: { orchestrator: "atlas", executor: "forge", reviewer: "mirror" },
      reviewer: "mirror",
      extraArgs: ["--reviewer-model", "mirror/local-reviewer"],
    },
  ]) {
    await t.test(entry.label, () => {
      const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
        reviewAssurance: "hardened",
        strictEvidence: true,
        roles: entry.roles,
      });
      const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
      const opencodeScript = writeFakeOpencode(repoRoot);

      const result = runReview({
        repoRoot,
        runId,
        doneCriteriaPath,
        diffPath,
        primaryScript,
        opencodeScript,
        reviewer: entry.reviewer,
        extraArgs: entry.extraArgs || [],
      });
      const manifest = readManifest(manifestPath).data;

      assert.equal(result.nextState, STATES.READY_TO_MERGE);
      assert.equal(manifest.state, STATES.READY_TO_MERGE);
      assert.deepEqual(manifest.roles, entry.roles);
      assert.equal(manifest.policy.review_assurance, "hardened");
      assert.equal(manifest.review.last_reviewer, entry.reviewer);
    });
  }
});

test("Codex-only assurance regression is documented as generic policy coverage", () => {
  const notes = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "skills", "relay-review", "references", "runner-notes.md"),
    "utf-8"
  );

  assert.match(notes, /Codex-only operation regression/i);
  assert.match(notes, /policy\.review_assurance=hardened/i);
  assert.match(notes, /not a Codex-only policy special case/i);
});

test("production assurance code does not branch on Codex executor and reviewer identity", () => {
  const productionFiles = [
    "skills/relay-review/scripts/review-runner.js",
    "skills/relay-review/scripts/review-runner/assurance.js",
    "skills/relay-merge/scripts/review-gate.js",
    "skills/relay-merge/scripts/gate-check.js",
    "skills/relay-merge/scripts/finalize-run.js",
    "skills/relay-dispatch/scripts/relay-manifest.js",
    "skills/relay-dispatch/scripts/manifest/store.js",
  ];

  const forbiddenBranch = new RegExp([
    String.raw`(?:executor|roles\.executor)[\s\S]{0,80}(?:["']codex["'])`,
    String.raw`[\s\S]{0,160}(?:reviewer|roles\.reviewer)[\s\S]{0,80}(?:["']codex["'])`,
    "|",
    String.raw`(?:reviewer|roles\.reviewer)[\s\S]{0,80}(?:["']codex["'])`,
    String.raw`[\s\S]{0,160}(?:executor|roles\.executor)[\s\S]{0,80}(?:["']codex["'])`,
  ].join(""), "i");

  for (const relativePath of productionFiles) {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", relativePath), "utf-8");
    assert.doesNotMatch(source, forbiddenBranch, relativePath);
  }
});

function laneResult(overrides = {}) {
  return {
    advisory_count: 0,
    duplicate_low_confidence_count: 0,
    failureReason: null,
    gating: false,
    profile: "blindspot",
    required_count: 0,
    reviewer: "opencode",
    status: "success",
    trigger: "every_round",
    ...overrides,
  };
}

test("assurance fold applies lane gating matrix without changing no-lane standard behavior", async (t) => {
  await t.test("no lanes leaves standard pass byte-identical", () => {
    const verdict = passVerdict();
    const result = applyReviewAssurancePolicy(verdict, {
      advisoryResults: [],
      hardenedAssurance: false,
    });

    assert.deepEqual(result, verdict);
  });

  await t.test("standard non-gating lane required findings are advisory only", () => {
    const result = applyReviewAssurancePolicy(passVerdict(), {
      advisoryResults: [laneResult({ required_count: 1 })],
      hardenedAssurance: false,
    });

    assert.equal(result.verdict, "pass");
  });

  await t.test("standard gating lane required findings demote an applied pass", () => {
    const result = applyReviewAssurancePolicy(passVerdict(), {
      advisoryResults: [laneResult({ gating: true, required_count: 2 })],
      hardenedAssurance: false,
      laneDemotionCount: 0,
    });

    assert.equal(result.verdict, "changes_requested");
    assert.match(result.summary, /gating advisory lane/i);
    assert.equal(result.issues[0].confidence, "high");
  });

  await t.test("standard gating lane infrastructure failure warns without demotion", () => {
    const result = applyReviewAssurancePolicy(passVerdict(), {
      advisoryResults: [laneResult({ gating: true, status: "failed", failureReason: "bad json" })],
      hardenedAssurance: false,
    });

    assert.equal(result.verdict, "pass");
  });

  await t.test("hardened makes every lane effectively gating for failures and findings", () => {
    const failed = applyReviewAssurancePolicy(passVerdict(), {
      advisoryResults: [laneResult({ status: "failed", failureReason: "bad json" })],
      hardenedAssurance: true,
    });
    const required = applyReviewAssurancePolicy(passVerdict(), {
      advisoryResults: [laneResult({ required_count: 1 })],
      hardenedAssurance: true,
    });

    assert.equal(failed.verdict, "changes_requested");
    assert.match(failed.summary, /did not complete successfully/i);
    assert.equal(required.verdict, "changes_requested");
    assert.match(required.summary, /required findings/i);
  });

  await t.test("third lane-driven demotion escalates with cap reason", () => {
    const result = applyReviewAssurancePolicy(passVerdict(), {
      advisoryResults: [laneResult({ gating: true, required_count: 1 })],
      hardenedAssurance: false,
      laneDemotionCount: 2,
    });

    assert.equal(result.verdict, "escalated");
    assert.match(result.summary, /demotion cap/i);
    assert.match(result.issues[0].body, /at most 2/i);
  });

  await t.test("hardened lane failures and missing evidence share the same demotion cap", () => {
    const failed = applyReviewAssurancePolicy(passVerdict(), {
      advisoryResults: [laneResult({ status: "failed", failureReason: "bad json" })],
      hardenedAssurance: true,
      laneDemotionCount: 2,
    });
    const missing = applyReviewAssurancePolicy(passVerdict(), {
      advisoryResults: [],
      expectedAdvisoryCount: 1,
      hardenedAssurance: true,
      laneDemotionCount: 2,
    });

    assert.equal(failed.verdict, "escalated");
    assert.match(failed.summary, /demotion cap/i);
    assert.match(failed.issues[0].body, /Hardened advisory review did not complete successfully/);
    assert.equal(missing.verdict, "escalated");
    assert.match(missing.summary, /demotion cap/i);
    assert.match(missing.issues[0].body, /Missing hardened advisory review/);
  });
});

test("hardened review assurance blocks advisory failures and required findings", async (t) => {
  for (const entry of [
    { label: "invalid json", options: { invalidJson: true }, expected: /Hardened advisory review did not complete successfully/ },
    { label: "required finding", options: { requiredFinding: true }, expected: /Hardened advisory review reported required findings/ },
  ]) {
    await t.test(entry.label, () => {
      const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
        reviewAssurance: "hardened",
        strictEvidence: true,
      });
      const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
      const opencodeScript = writeFakeOpencode(repoRoot, entry.options);

      const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });

      assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
      assert.equal(readManifest(manifestPath).data.state, STATES.CHANGES_REQUESTED);
      assert.match(fs.readFileSync(result.verdictPath, "utf-8"), entry.expected);
    });
  }
});

test("hardened manual review pass requires an audit reason", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
    reviewAssurance: "hardened",
    strictEvidence: true,
  });
  const reviewFile = path.join(repoRoot, "manual-verdict.json");
  fs.writeFileSync(reviewFile, JSON.stringify(passVerdict()), "utf-8");
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--advisory-reviewer", "opencode",
    "--advisory-reviewer-model", "example/opencode-model-fast",
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_OPENCODE_BIN: opencodeScript },
  }));

  assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
  assert.equal(readManifest(manifestPath).data.state, STATES.CHANGES_REQUESTED);
  assert.match(fs.readFileSync(result.verdictPath, "utf-8"), /Manual review verdict requires an audit reason/);
});
