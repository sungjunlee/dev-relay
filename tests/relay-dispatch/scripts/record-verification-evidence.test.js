const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES, createManifestSkeleton, createRunId, ensureRunLayout, updateManifestState, writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const { writeExecutionEvidence } = require("../../../skills/relay-dispatch/scripts/execution-evidence");
const { COMMAND_FLAGS } = require("../../../skills/relay-dispatch/scripts/cli-schema");
const { computeQualityExecutionStatus } = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "record-verification-evidence.js");

function fixture() {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-record-evidence-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-record-home-")));
  process.env.RELAY_HOME = relayHome;
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repoRoot }); execFileSync("git", ["commit", "-m", "base"], { cwd: repoRoot });
  const worktree = path.join(repoRoot, "wt"); execFileSync("git", ["worktree", "add", worktree, "-b", "issue-1113"], { cwd: repoRoot });
  const head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const runId = createRunId({ issueNumber: 1113, branch: "issue-1113", timestamp: new Date("2026-07-31T00:00:00Z") });
  const layout = ensureRunLayout(repoRoot, runId);
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), [
    "evaluation:", "  verification:", "    checks:", "      - name: unit", "        type: command", "        command: node -e \"process.stdout.write('ok')\"",
    "      - name: screenshot", "        type: observation", "        command: node -e \"process.stdout.write('observed')\"",
  ].join("\n"));
  let manifest = createManifestSkeleton({ repoRoot, runId, branch: "issue-1113", baseBranch: "main", issueNumber: 1113, worktreePath: worktree, orchestrator: "codex", executor: "codex", reviewer: "codex" });
  manifest.anchor.rubric_path = "rubric.yaml";
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "review");
  manifest.git.head_sha = head; writeManifest(layout.manifestPath, manifest);
  writeExecutionEvidence(layout.runDir, { schema_version: 1, head_sha: head, test_command: "unspecified", test_result_hash: "unspecified", test_result_summary: "unspecified", recorded_at: "2026-07-31T00:00:00Z", recorded_by: "rebrand" });
  const observation = path.join(repoRoot, "observation.txt"); fs.writeFileSync(observation, "checked\n");
  return { repoRoot, relayHome, runId, runDir: layout.runDir, head, observation, manifest };
}

function invoke(item, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, "--repo", item.repoRoot, "--run-id", item.runId, "--reason", "same-head audited re-verification", ...extra], { cwd: item.repoRoot, encoding: "utf8", env: { ...process.env, RELAY_HOME: item.relayHome } });
}

test("CLI schema registers record-verification-evidence", () => {
  assert.deepEqual(COMMAND_FLAGS["record-verification-evidence"], ["--repo", "--run-id", "--manifest", "--reason", "--observation-result", "--dry-run", "--json", "--help"]);
});

test("records exact command and hash-backed observation only for strict missing gates", () => {
  const item = fixture();
  const dry = invoke(item, ["--observation-result", `screenshot=${item.observation}`, "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).status, "dry_run");
  const result = invoke(item, ["--observation-result", `screenshot=${item.observation}`, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(path.join(item.runDir, "execution-evidence.json"), "utf8"));
  assert.equal(evidence.head_sha, item.head); assert.equal(evidence.verification_runs.length, 2);
  assert.equal(evidence.verification_runs[0].command, "node -e \"process.stdout.write('ok')\"");
  assert.equal(evidence.verification_runs[0].verification_tree_sha.length, 40);
  assert.equal(evidence.verification_runs[1].command, "node -e \"process.stdout.write('observed')\"");
  assert.equal(evidence.verification_runs[1].gate_type, "observation");
  assert.ok(fs.existsSync(path.join(item.runDir, evidence.verification_runs[1].output_path)));
  const events = readRunEvents(item.repoRoot, item.runId).filter((entry) => entry.event === "operator_execution_evidence");
  assert.equal(events.length, 1); assert.deepEqual(events[0].after.gate_names, ["unit", "screenshot"]);
  evidence.verification_runs.pop(); fs.writeFileSync(path.join(item.runDir, "execution-evidence.json"), `${JSON.stringify(evidence)}\n`);
  const strict = computeQualityExecutionStatus({ runDir: item.runDir, reviewedHead: item.head, strict: true, manifestData: item.manifest });
  assert.equal(strict.status, "fail"); assert.match(strict.reason, /screenshot/);
});

test("refuses arbitrary overwrite after the strict preflight is already satisfied", () => {
  const item = fixture();
  assert.equal(invoke(item, ["--observation-result", `screenshot=${item.observation}`]).status, 0);
  const second = invoke(item, ["--observation-result", `screenshot=${item.observation}`]);
  assert.notEqual(second.status, 0); assert.match(second.stderr, /refusing replacement/);
});

test("refuses observation symlinks", () => {
  const item = fixture(); const link = path.join(item.repoRoot, "observation-link"); fs.symlinkSync(item.observation, link);
  const result = invoke(item, ["--observation-result", `screenshot=${link}`]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /regular non-symlink/);
});

test("copies binary observation artifacts without decoding them", () => {
  const item = fixture(); const bytes = Buffer.from([0, 255, 128, 10]); fs.writeFileSync(item.observation, bytes);
  const result = invoke(item, ["--observation-result", `screenshot=${item.observation}`]);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(path.join(item.runDir, "execution-evidence.json"), "utf8"));
  assert.deepEqual(fs.readFileSync(path.join(item.runDir, evidence.verification_runs[1].output_path)), bytes);
});
