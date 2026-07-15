"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DISPATCH_JS = path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");
const ATTACH_MARKER_JS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "attach-marker.js");
const STATUS_JS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "status.js");
const RESUME_JS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "resume.js");

const { COMMAND_FLAGS, FLAGS } = require(path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "cli-schema.js"));
const { buildOperatorPrompt } = require(path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "lib", "operator-prompt.js"));
const { programSegment } = require(path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "receipt-io.js"));
const { createManifestSkeleton, writeManifest } = require(path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "manifest", "store.js"));
const { getRepoSlug } = require(path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "manifest", "paths.js"));
const { serializeReceipt, RECEIPT_NOTE } = require(path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "lib", "receipt.js"));
const { installFakeOrcaStatus } = require(path.join(__dirname, "..", "fixtures", "fake-orca-status.js"));
const { installFakeOrcaResume } = require(path.join(__dirname, "..", "fixtures", "fake-orca-resume.js"));
const { installFakeGh } = require(path.join(__dirname, "..", "fixtures", "fake-gh.js"));
const { DEFAULT_RUNTIME_ID } = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));

function initGitRepo(repoRoot) {
  const git = (args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf-8", stdio: "pipe" });
  fs.mkdirSync(repoRoot, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "marker-test"]);
  git(["config", "user.email", "marker-test@example.com"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "marker fixture\n", "utf-8");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);
}

function shellRun(script, args, options = {}) {
  const result = { status: 0, stdout: "", stderr: "" };
  try {
    result.stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (error) {
    result.status = error.status || 1;
    result.stdout = error.stdout ? String(error.stdout) : "";
    result.stderr = error.stderr ? String(error.stderr) : "";
  }
  result.body = result.stdout ? JSON.parse(result.stdout) : null;
  return result;
}

function writeProgram(dir, programId = "repilot-marker") {
  const program = {
    id: programId,
    exit_gates: ["all accepted outcomes complete"],
    outcomes: [{
      id: "outcome-a",
      issue: 100,
      task_kind: "relay_run",
      accepted_outcomes: ["the issue is fixed"],
    }],
  };
  const file = path.join(dir, "accepted-program.json");
  fs.writeFileSync(file, `${JSON.stringify(program, null, 2)}\n`, "utf-8");
  return { file, program };
}

function markerFor(programId, outcomeId = "outcome-a") {
  return `relay-orca: ${programSegment(programId)}/${outcomeId}`;
}

function writeRun({ repoRoot, relayHome, runId = "issue-100-20260715120000000-aabbccdd", issue = 100, marker = null, state = "dispatched", prNumber = null }) {
  const manifestPath = path.join(relayHome, "runs", getRepoSlug(repoRoot), `${runId}.md`);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-100",
    baseBranch: "main",
    issueNumber: issue,
    worktreePath: null,
  });
  const data = {
    ...manifest,
    state,
    next_action: state === "merged" ? "none" : "await_dispatch_result",
    paths: { ...manifest.paths, repo_root: repoRoot, worktree: null },
    git: { ...manifest.git, pr_number: prNumber },
    ...(marker ? { coordination: { marker } } : {}),
  };
  writeManifest(manifestPath, data);
  return { manifestPath, runId, eventsPath: path.join(path.dirname(manifestPath), runId, "events.jsonl") };
}

function writeReceipt({ relayHome, repoRoot, programId, runId = null }) {
  const slug = getRepoSlug(repoRoot);
  const receiptPath = path.join(relayHome, "programs", slug, programSegment(programId), "receipt.json");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const receipt = {
    schema: 1,
    program_id: programId,
    source: "/tmp/accepted-program.json",
    repo: { slug, root: repoRoot },
    runtime_id: DEFAULT_RUNTIME_ID,
    tasks: [{
      outcome_id: "outcome-a",
      task_id: "orca-task-outcome-a",
      kind: "relay_run",
      wave: 1,
      orca_task_id: "orca-live-outcome-a",
      dispatch_id: "disp-orca-live-outcome-a",
      assignee: "term-outcome-a",
      relay_ids: { request: null, run: runId, fleet: null },
    }],
    terminals_created: [],
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    note: RECEIPT_NOTE,
  };
  fs.writeFileSync(receiptPath, serializeReceipt(receipt), "utf-8");
  return receiptPath;
}

function fakeOrcaTask(programId, status = "dispatched") {
  return {
    id: "orca-live-outcome-a",
    task_title: markerFor(programId),
    display_name: markerFor(programId),
    status,
    worker_done: status === "completed",
  };
}

function envFor({ relayHome, programsRoot, runsRoot, repoRoot, orcaPath, ghPath }) {
  return {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_ORCA_PROGRAMS_ROOT: programsRoot || path.join(relayHome, "programs"),
    RELAY_ORCA_RUNS_ROOT: runsRoot || path.join(relayHome, "runs"),
    RELAY_ORCA_FLEETS_ROOT: path.join(relayHome, "fleets"),
    ...(orcaPath ? { RELAY_ORCA_ORCA_BIN: orcaPath } : {}),
    ...(ghPath ? { RELAY_ORCA_GH_BIN: ghPath } : {}),
    TEST_REPO_ROOT: repoRoot,
  };
}

test("marker CLI/schema and relay-orca operator contract are first-class and outcome-scoped", () => {
  assert.ok(COMMAND_FLAGS.dispatch.includes("--coordination-marker"));
  const definition = FLAGS.find((entry) => entry.flag === "--coordination-marker");
  assert.deepEqual({ kind: definition.kind, mode: definition.mode }, { kind: "value", mode: "verbatim" });

  const program = { id: "wave-program", outcomes: [] };
  const prompts = ["outcome-a", "outcome-b"].map((outcomeId) => buildOperatorPrompt(
    { outcome_id: outcomeId, kind: "relay_run", wave: 1, recommended_route: { operator: "relay", mode: "single_run", read_only: false }, expected_evidence: [] },
    program,
    { accepted_outcomes: ["done"] },
    programSegment,
  ));
  assert.match(prompts[0], /--coordination-marker/);
  assert.match(prompts[0], new RegExp(markerFor(program.id, "outcome-a").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompts[0], /fail closed|fail-closed/i);
  assert.notEqual(prompts[0].match(/relay-orca: [^\n]+/)[0], prompts[1].match(/relay-orca: [^\n]+/)[0]);
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /codex|claude|cursor|cline|opencode|gpt|glm/i);
  }
});

test("dispatch persists the exact marker before fake executor spawn, preserves it on rewrite, and rejects unsafe values before worktree mutation", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-marker-dispatch-"));
  const repoRoot = path.join(base, "repo");
  const relayHome = path.join(base, "relay");
  const binDir = path.join(base, "bin");
  const observedPath = path.join(base, "executor-observed.txt");
  const rubricPath = path.join(base, "rubric.yaml");
  fs.mkdirSync(binDir, { recursive: true });
  initGitRepo(repoRoot);
  fs.writeFileSync(rubricPath, "rubric:\n  factors:\n    - name: marker\n      target: \">= 1/1\"\n", "utf-8");
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const cp = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("fake-codex\\n"); process.exit(0); }
if (args[0] !== "exec") process.exit(2);
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
const root = process.env.RELAY_HOME;
const manifests = [];
for (const slug of fs.readdirSync(root + "/runs", { withFileTypes: true })) {
  if (!slug.isDirectory()) continue;
  for (const name of fs.readdirSync(root + "/runs/" + slug.name)) if (name.endsWith(".md")) manifests.push(fs.readFileSync(root + "/runs/" + slug.name + "/" + name, "utf8"));
}
fs.writeFileSync(process.env.RELAY_TEST_EXECUTOR_OBSERVED, manifests.join("\\n"), "utf8");
fs.writeFileSync(cwd + "/executor.txt", "done\\n", "utf8");
cp.execFileSync("git", ["-C", cwd, "add", "executor.txt"]);
cp.execFileSync("git", ["-C", cwd, "commit", "-m", "executor"]);
fs.writeFileSync(output, "done\\n", "utf8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  const marker = markerFor("dispatch-program");
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome, RELAY_TEST_EXECUTOR_OBSERVED: observedPath };
  try {
    const result = shellRun(DISPATCH_JS, [repoRoot, "--branch", "issue-100", "--prompt", "implement", "--executor", "codex", "--rubric-file", rubricPath, "--publish-policy", "after-internal-review", "--coordination-marker", marker, "--json"], { cwd: repoRoot, env });
    assert.equal(result.status, 0, result.stderr);
    const raw = fs.readFileSync(result.body.manifestPath, "utf-8");
    assert.equal((raw.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
    assert.match(fs.readFileSync(observedPath, "utf-8"), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(result.body.runState, "internal_review_pending");

    const unsafe = shellRun(DISPATCH_JS, [repoRoot, "--branch", "issue-101", "--prompt", "implement", "--executor", "codex", "--rubric-file", rubricPath, "--coordination-marker", "unsafe\nmarker", "--json"], { cwd: repoRoot, env });
    assert.notEqual(unsafe.status, 0);
    assert.match(`${unsafe.stdout}\n${unsafe.stderr}`, /single-line|unsafe|marker/i);
    const runFiles = fs.existsSync(path.join(relayHome, "runs")) ? fs.readdirSync(path.join(relayHome, "runs"), { recursive: true }) : [];
    assert.equal(runFiles.some((entry) => String(entry).includes("issue-101")), false, "unsafe marker must fail before run/worktree mutation");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("recovery is audited, idempotent, concurrent-safe, strict, and closes status -> existing map-relay-run", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-marker-recovery-"));
  const repoRoot = path.join(base, "repo");
  const relayHome = path.join(base, "relay");
  const programsRoot = path.join(relayHome, "programs");
  const runsRoot = path.join(relayHome, "runs");
  fs.mkdirSync(repoRoot, { recursive: true });
  initGitRepo(repoRoot);
  const { file: programFile, program } = writeProgram(base);
  const run = writeRun({ repoRoot, relayHome, state: "dispatched" });
  const slug = getRepoSlug(repoRoot);
  writeReceipt({ relayHome, repoRoot, programId: program.id, runId: null });
  const statusOrca = installFakeOrcaStatus({ tasks: [fakeOrcaTask(program.id)] });
  const statusGh = installFakeGh();
  const env = envFor({ relayHome, programsRoot, runsRoot, repoRoot });
  try {
    const before = shellRun(STATUS_JS, ["--program-id", program.id, "--json", "--orca-bin", statusOrca.orcaPath, "--gh-bin", statusGh.ghPath, "--repo-root", repoRoot], { cwd: repoRoot, env });
    assert.equal(before.status, 0, before.stderr);
    assert.deepEqual(before.body.repair_candidates, []);

    const failedProgram = path.join(base, "wrong-program.json");
    fs.writeFileSync(failedProgram, JSON.stringify({ ...program, id: "wrong-program", outcomes: [{ ...program.outcomes[0], issue: 999 }] }), "utf-8");
    const manifestBeforeFailure = fs.readFileSync(run.manifestPath, "utf-8");
    const eventsPath = path.join(runsRoot, slug, run.runId, "events.jsonl");
    const eventsBeforeFailure = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "";
    const wrongOutcome = path.join(base, "wrong-outcome.json");
    fs.writeFileSync(wrongOutcome, JSON.stringify({
      ...program,
      outcomes: [{ ...program.outcomes[0], id: "outcome-other" }],
    }), "utf-8");
    const wrongOutcomeResult = shellRun(ATTACH_MARKER_JS, ["--program-file", wrongOutcome, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.notEqual(wrongOutcomeResult.status, 0);
    assert.equal(fs.readFileSync(run.manifestPath, "utf-8"), manifestBeforeFailure);
    assert.equal(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "", eventsBeforeFailure);

    const malformedProgram = path.join(base, "malformed-program.json");
    fs.writeFileSync(malformedProgram, "{not-json\n", "utf-8");
    const malformed = shellRun(ATTACH_MARKER_JS, ["--program-file", malformedProgram, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.notEqual(malformed.status, 0);
    assert.equal(fs.readFileSync(run.manifestPath, "utf-8"), manifestBeforeFailure);
    assert.equal(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "", eventsBeforeFailure);

    const mismatch = shellRun(ATTACH_MARKER_JS, ["--program-file", failedProgram, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.notEqual(mismatch.status, 0);
    assert.equal(fs.readFileSync(run.manifestPath, "utf-8"), manifestBeforeFailure);
    assert.equal(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "", eventsBeforeFailure);

    const attach = shellRun(ATTACH_MARKER_JS, ["--program-file", programFile, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.equal(attach.status, 0, attach.stderr);
    assert.equal(attach.body.result, "attached");
    assert.equal(JSON.parse(JSON.stringify(require(path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "manifest", "store.js")).readManifest(run.manifestPath).data)).coordination.marker, markerFor(program.id));
    assert.match(fs.readFileSync(eventsPath, "utf-8"), /coordination_marker_attached/);
    const receiptAfterAttach = fs.readFileSync(path.join(programsRoot, slug, programSegment(program.id), "receipt.json"), "utf-8");

    const duplicate = shellRun(ATTACH_MARKER_JS, ["--program-file", programFile, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(duplicate.body.result, "already_present");
    assert.equal(fs.readFileSync(path.join(programsRoot, slug, programSegment(program.id), "receipt.json"), "utf-8"), receiptAfterAttach, "recovery never edits the relay-orca receipt");

    const conflictProgram = path.join(base, "conflict-program.json");
    fs.writeFileSync(conflictProgram, JSON.stringify({ ...program, id: "conflicting-program", outcomes: [{ ...program.outcomes[0] }] }), "utf-8");
    const manifestBeforeConflict = fs.readFileSync(run.manifestPath, "utf-8");
    const eventsBeforeConflict = fs.readFileSync(eventsPath, "utf-8");
    const conflict = shellRun(ATTACH_MARKER_JS, ["--program-file", conflictProgram, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.notEqual(conflict.status, 0);
    assert.equal(conflict.body.result, undefined);
    assert.equal(fs.readFileSync(run.manifestPath, "utf-8"), manifestBeforeConflict);
    assert.equal(fs.readFileSync(eventsPath, "utf-8"), eventsBeforeConflict);

    const concurrentRun = writeRun({ repoRoot, relayHome, runId: "issue-100-20260715120000001-aabbccdd", state: "dispatched" });
    const concurrent = await Promise.all([1, 2].map(() => new Promise((resolve) => {
      const child = spawn(process.execPath, [ATTACH_MARKER_JS, "--program-file", programFile, "--outcome-id", "outcome-a", "--run-id", concurrentRun.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    })));
    assert.deepEqual(concurrent.map((entry) => entry.code), [0, 0]);
    const concurrentEvents = fs.readFileSync(concurrentRun.eventsPath, "utf-8");
    assert.equal((concurrentEvents.match(/coordination_marker_attached/g) || []).length, 1);

    const after = shellRun(STATUS_JS, ["--program-id", program.id, "--json", "--orca-bin", statusOrca.orcaPath, "--gh-bin", statusGh.ghPath, "--repo-root", repoRoot], { cwd: repoRoot, env });
    assert.equal(after.status, 0, after.stderr);
    assert.ok(after.body.repair_candidates.some((entry) => entry.kind === "adopt_relay_run" && entry.proposal.includes(run.runId)));

    const terminalManifest = require(path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "manifest", "store.js")).readManifest(run.manifestPath);
    writeManifest(run.manifestPath, { ...terminalManifest.data, state: "merged", git: { ...terminalManifest.data.git, pr_number: 10 } }, terminalManifest.body);
    const terminalOrca = installFakeOrcaResume({ tasks: [fakeOrcaTask(program.id, "completed")] });
    const terminalGh = installFakeGh({ prs: { 10: { state: "MERGED", mergedAt: "2026-07-15T00:00:00Z" } }, issues: { 100: { state: "CLOSED", stateReason: "COMPLETED" } } });
    const resume = shellRun(RESUME_JS, ["--program-id", program.id, "--program-file", programFile, "--map-relay-run", `${program.outcomes[0].id}=${run.runId}`, "--orca-bin", terminalOrca.orcaPath, "--gh-bin", terminalGh.ghPath, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.equal(resume.status, 0, resume.stderr);
    assert.equal(resume.body.ok, true);
    const mappedReceipt = JSON.parse(receiptAfterAttach);
    const receiptOnDisk = JSON.parse(fs.readFileSync(path.join(programsRoot, slug, programSegment(program.id), "receipt.json"), "utf-8"));
    assert.equal(receiptOnDisk.tasks[0].relay_ids.run, run.runId);
    assert.equal(receiptOnDisk.tasks[0].relay_ids.run, mappedReceipt.tasks[0].relay_ids.run || run.runId);
    assert.equal(statusOrca.readPoison(), null);
    assert.equal(statusGh.readPoison(), null);
    assert.equal(terminalOrca.readPoison(), null);
    assert.equal(terminalGh.readPoison(), null);
  } finally {
    statusOrca.cleanup();
    statusGh.cleanup();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
