const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
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

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

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

function invokeAsync(item, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--repo", item.repoRoot, "--run-id", item.runId, "--reason", "same-head audited re-verification", ...extra], { cwd: item.repoRoot, env: { ...process.env, RELAY_HOME: item.relayHome } });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stderr }));
  });
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

test("nonzero command preserves the old evidence and leaves only bounded diagnostics", () => {
  const item = fixture(); const evidencePath = path.join(item.runDir, "execution-evidence.json"); const before = fs.readFileSync(evidencePath, "utf8");
  fs.writeFileSync(path.join(item.runDir, "rubric.yaml"), "evaluation:\n  verification:\n    checks:\n      - name: unit\n        type: command\n        command: node -e \"process.exit(7)\"\n");
  const result = invoke(item);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /exited 7/);
  assert.equal(fs.readFileSync(evidencePath, "utf8"), before);
  const diagnosticDir = fs.readdirSync(item.runDir).find((name) => name.startsWith(".operator-verification-"));
  assert.ok(diagnosticDir); assert.ok(fs.existsSync(path.join(item.runDir, diagnosticDir, "operator-verification-gate-1.log")));
});

test("refuses symlinked log destinations without touching their target", () => {
  const item = fixture(); const victim = path.join(item.repoRoot, "victim.txt"); fs.writeFileSync(victim, "keep");
  fs.symlinkSync(victim, path.join(item.runDir, "operator-verification-gate-1.log"));
  const result = invoke(item, ["--observation-result", `screenshot=${item.observation}`]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /symlinked verification artifact destination/);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
});

test("replaces stale regular destinations atomically and normalizes private mode", () => {
  const item = fixture(); const stale = path.join(item.runDir, "operator-verification-gate-1.log");
  fs.writeFileSync(stale, "stale"); fs.chmodSync(stale, 0o644);
  const result = invoke(item, ["--observation-result", `screenshot=${item.observation}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(stale).mode & 0o777, 0o600);
  assert.notEqual(fs.readFileSync(stale, "utf8"), "stale");
});

test("concurrent recorders serialize final replacement and reject the loser", async () => {
  const item = fixture();
  const rubricPath = path.join(item.runDir, "rubric.yaml");
  fs.writeFileSync(rubricPath, [
    "evaluation:", "  verification:", "    checks:", "      - name: unit", "        type: command",
    "        command: node -e \"const fs=require('fs'); const p=process.env.RELAY_HOME + '/race'; if (!fs.existsSync(p)) { fs.writeFileSync(p, '1'); setTimeout(() => process.stdout.write('first'), 50); } else { setTimeout(() => process.stdout.write('second'), 500); }\"",
    "      - name: screenshot", "        type: observation", "        command: node -e \"process.stdout.write('observed')\"",
  ].join("\n"));
  const args = ["--observation-result", `screenshot=${item.observation}`];
  const [left, right] = await Promise.all([invokeAsync(item, args), invokeAsync(item, args)]);
  assert.deepEqual([left.status, right.status].sort(), [0, 1]);
  assert.match(
    `${left.stderr}${right.stderr}`,
    /(?:execution evidence|strict preflight) changed while verification was executing/
  );
  const evidence = JSON.parse(fs.readFileSync(path.join(item.runDir, "execution-evidence.json"), "utf8"));
  assert.equal(hashFile(path.join(item.runDir, evidence.verification_runs[0].output_path)), evidence.verification_runs[0].output_hash);
});

test("event append failure leaves old evidence in place", () => {
  const item = fixture(); const evidencePath = path.join(item.runDir, "execution-evidence.json"); const before = fs.readFileSync(evidencePath, "utf8");
  fs.symlinkSync(path.join(item.repoRoot, "events-target"), path.join(item.runDir, "events.jsonl"));
  const result = invoke(item, ["--observation-result", `screenshot=${item.observation}`]);
  assert.notEqual(result.status, 0); assert.equal(fs.readFileSync(evidencePath, "utf8"), before);
});
