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
const { shellQuote } = require(path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "lib", "coordination-marker.js"));
const { programSegment } = require(path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "receipt-io.js"));
const {
  createManifestSkeleton,
  getManifestLockPath,
  writeManifest,
} = require(path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "manifest", "store.js"));
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

function writeRun({ repoRoot, relayHome, runsRoot = path.join(relayHome, "runs"), runId = "issue-100-20260715120000000-aabbccdd", issue = 100, marker = null, state = "dispatched", prNumber = null }) {
  const manifestPath = path.join(runsRoot, getRepoSlug(repoRoot), `${runId}.md`);
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
  assert.match(prompts[0], /\$\{RELAY_SKILL_ROOT:-skills\}\/relay-dispatch\/scripts\/dispatch\.js/);
  assert.match(prompts[0], new RegExp(markerFor(program.id, "outcome-a").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompts[0], new RegExp(`--coordination-marker ${shellQuote(markerFor(program.id, "outcome-a")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(prompts[0], /--coordination-marker \"relay-orca:/);
  assert.match(prompts[0], /fail closed|fail-closed/i);
  assert.notEqual(prompts[0].match(/relay-orca: [^\n]+/)[0], prompts[1].match(/relay-orca: [^\n]+/)[0]);
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /codex|claude|cursor|cline|opencode|gpt|glm/i);
  }
});

test("operator prompt shell-quotes marker values containing apostrophes", () => {
  const program = { id: "shell-quote-program", outcomes: [] };
  const outcomeId = "outcome-'a";
  const prompt = buildOperatorPrompt(
    { outcome_id: outcomeId, kind: "relay_run", wave: 1, recommended_route: { operator: "relay", mode: "single_run", read_only: false }, expected_evidence: [] },
    program,
    { accepted_outcomes: ["done"] },
    programSegment,
  );
  const marker = markerFor(program.id, outcomeId);
  assert.match(prompt, new RegExp(`--coordination-marker ${shellQuote(marker).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
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
    const failedObservedPath = path.join(base, "executor-should-not-run.txt");
    const renameFailurePreload = path.join(binDir, "fail-marker-manifest-write.js");
    fs.writeFileSync(renameFailurePreload, `const fs = require("fs");
const originalRenameSync = fs.renameSync;
fs.renameSync = function(source, target) {
  if (process.env.RELAY_TEST_FAIL_MARKER_MANIFEST_WRITE === "1" && String(target).endsWith(".md")) {
    const error = new Error("injected marker manifest persistence failure");
    error.code = "EIO";
    throw error;
  }
  return originalRenameSync.apply(this, arguments);
};
`, "utf-8");
    const failed = shellRun(DISPATCH_JS, [repoRoot, "--branch", "issue-102", "--prompt", "implement", "--executor", "codex", "--rubric-file", rubricPath, "--coordination-marker", marker, "--json"], {
      cwd: repoRoot,
      env: {
        ...env,
        RELAY_TEST_EXECUTOR_OBSERVED: failedObservedPath,
        RELAY_TEST_FAIL_MARKER_MANIFEST_WRITE: "1",
        NODE_OPTIONS: `--require ${renameFailurePreload}`,
      },
    });
    assert.notEqual(failed.status, 0);
    assert.match(`${failed.stdout}\n${failed.stderr}`, /before worktree creation|persistence failure/i);
    const worktreesDir = path.join(relayHome, "worktrees");
    assert.equal(fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir).length : 0, 0, "marker persistence failure must create no worktree");
    assert.equal(fs.existsSync(failedObservedPath), false, "marker persistence failure must not invoke the executor");

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
  const runsRoot = path.join(relayHome, "recovery-runs");
  fs.mkdirSync(repoRoot, { recursive: true });
  initGitRepo(repoRoot);
  const { file: programFile, program } = writeProgram(base);
  const run = writeRun({ repoRoot, relayHome, runsRoot, state: "dispatched" });
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
    assert.equal(attach.status, 0, `${attach.stderr}\n${JSON.stringify(attach.body)}`);
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

    const concurrentRun = writeRun({ repoRoot, relayHome, runsRoot, runId: "issue-100-20260715120000001-aabbccdd", state: "dispatched" });
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

test("attach-marker rolls back the manifest when the coordination audit append fails", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-marker-event-failure-"));
  const repoRoot = path.join(base, "repo");
  const relayHome = path.join(base, "relay");
  const runsRoot = path.join(relayHome, "override-runs");
  initGitRepo(repoRoot);
  const { file: programFile, program } = writeProgram(base, "event-failure-program");
  const run = writeRun({ repoRoot, relayHome, runsRoot });
  const eventsPath = run.eventsPath;
  const preloadPath = path.join(base, "fail-event-append.js");
  fs.writeFileSync(preloadPath, `const fs = require("fs");
const originalOpenSync = fs.openSync;
fs.openSync = function(target, flags) {
  if (String(target) === process.env.RELAY_TEST_MARKER_EVENTS_PATH && (Number(flags) & fs.constants.O_APPEND)) {
    const error = new Error("injected coordination audit append failure");
    error.code = "EIO";
    throw error;
  }
  return originalOpenSync.apply(this, arguments);
};
`, "utf-8");
  const beforeManifest = fs.readFileSync(run.manifestPath, "utf-8");
  const env = {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_ORCA_RUNS_ROOT: runsRoot,
    RELAY_TEST_MARKER_EVENTS_PATH: eventsPath,
    NODE_OPTIONS: `--require ${preloadPath}`,
  };
  try {
    const result = shellRun(ATTACH_MARKER_JS, ["--program-file", programFile, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.notEqual(result.status, 0);
    assert.equal(result.body.reason_code, "ATTACH_MARKER_PERSISTENCE_FAILED", `${result.stderr}\n${JSON.stringify(result.body)}`);
    assert.equal(fs.readFileSync(run.manifestPath, "utf-8"), beforeManifest);
    assert.equal(fs.existsSync(eventsPath), false);
    assert.equal(fs.existsSync(getManifestLockPath(run.manifestPath)), false, "transaction lock must be released after rollback");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("attach-marker rollback preserves a symlinked events journal boundary", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-marker-event-symlink-failure-"));
  const repoRoot = path.join(base, "repo");
  const relayHome = path.join(base, "relay");
  const runsRoot = path.join(relayHome, "override-runs");
  initGitRepo(repoRoot);
  const { file: programFile, program } = writeProgram(base, "event-symlink-program");
  const run = writeRun({ repoRoot, relayHome, runsRoot });
  const foreignDir = fs.mkdtempSync(path.join(base, "foreign-events-"));
  const targetPath = path.join(foreignDir, "events.jsonl");
  fs.writeFileSync(targetPath, "pre-existing journal\n", "utf-8");
  fs.symlinkSync(targetPath, run.eventsPath);
  const beforeManifest = fs.readFileSync(run.manifestPath, "utf-8");
  const linkTarget = fs.readlinkSync(run.eventsPath);
  const preloadPath = path.join(base, "fail-event-append-symlink.js");
  fs.writeFileSync(preloadPath, `const fs = require("fs");
const originalOpenSync = fs.openSync;
fs.openSync = function(target, flags) {
  if (String(target) === process.env.RELAY_TEST_MARKER_EVENTS_PATH && (Number(flags) & fs.constants.O_APPEND)) {
    const error = new Error("injected coordination audit append failure");
    error.code = "EIO";
    throw error;
  }
  return originalOpenSync.apply(this, arguments);
};
`, "utf-8");
  const env = {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_ORCA_RUNS_ROOT: runsRoot,
    RELAY_TEST_MARKER_EVENTS_PATH: run.eventsPath,
    NODE_OPTIONS: `--require ${preloadPath}`,
  };
  try {
    const result = shellRun(ATTACH_MARKER_JS, ["--program-file", programFile, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.notEqual(result.status, 0);
    assert.equal(result.body.reason_code, "ATTACH_MARKER_PERSISTENCE_FAILED", `${result.stderr}\n${JSON.stringify(result.body)}`);
    assert.equal(fs.readFileSync(run.manifestPath, "utf-8"), beforeManifest);
    assert.equal(fs.lstatSync(run.eventsPath).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(run.eventsPath), linkTarget);
    assert.equal(fs.readFileSync(targetPath, "utf-8"), "pre-existing journal\n");
    assert.equal(fs.existsSync(getManifestLockPath(run.manifestPath)), false, "transaction lock must be released after symlink rollback");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("attach-marker preserves a lifecycle writer's stale update through the shared manifest boundary", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-marker-lifecycle-race-"));
  const repoRoot = path.join(base, "repo");
  const relayHome = path.join(base, "relay");
  const runsRoot = path.join(relayHome, "runs");
  initGitRepo(repoRoot);
  const { file: programFile, program } = writeProgram(base, "lifecycle-race-program");
  const run = writeRun({ repoRoot, relayHome, runsRoot });
  const readyPath = path.join(base, "writer-ready");
  const releasePath = path.join(base, "writer-release");
  const writerPath = path.join(base, "stale-writer.js");
  const storePath = path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "manifest", "store.js");
  fs.writeFileSync(writerPath, `const fs = require("fs");
const { readManifest, writeManifest } = require(${JSON.stringify(storePath)});
const manifestPath = process.argv[2];
const readyPath = process.argv[3];
const releasePath = process.argv[4];
const stale = readManifest(manifestPath);
fs.writeFileSync(readyPath, "ready");
while (!fs.existsSync(releasePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
writeManifest(manifestPath, { ...stale.data, state: "review_pending", next_action: "run_review" }, stale.body);
`, "utf-8");
  const writer = spawn(process.execPath, [writerPath, run.manifestPath, readyPath, releasePath], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const readyDeadline = Date.now() + 5000;
    while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(readyPath), true, "lifecycle writer must read before attach-marker starts");
    const env = { ...process.env, RELAY_HOME: relayHome, RELAY_ORCA_RUNS_ROOT: runsRoot };
    const attached = shellRun(ATTACH_MARKER_JS, ["--program-file", programFile, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], { cwd: repoRoot, env });
    assert.equal(attached.status, 0, `${attached.stderr}\n${JSON.stringify(attached.body)}`);
    fs.writeFileSync(releasePath, "release");
    await new Promise((resolve) => writer.once("close", resolve));
    const persisted = require(storePath).readManifest(run.manifestPath).data;
    assert.equal(persisted.state, "review_pending");
    assert.equal(persisted.coordination.marker, `relay-orca: ${programSegment(program.id)}/outcome-a`);
  } finally {
    if (!fs.existsSync(releasePath)) fs.writeFileSync(releasePath, "release");
    if (writer.exitCode === null) await new Promise((resolve) => writer.once("close", resolve));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("attach-marker automatically recovers a dead abandoned manifest lock", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-marker-abandoned-lock-"));
  const repoRoot = path.join(base, "repo");
  const relayHome = path.join(base, "relay");
  const runsRoot = path.join(relayHome, "runs");
  initGitRepo(repoRoot);
  const { file: programFile } = writeProgram(base, "abandoned-lock-program");
  const run = writeRun({ repoRoot, relayHome, runsRoot });
  const lockPath = getManifestLockPath(run.manifestPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, host: os.hostname(), token: "dead", acquired_at: "2000-01-01T00:00:00.000Z" }), "utf-8");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  try {
    const result = shellRun(ATTACH_MARKER_JS, ["--program-file", programFile, "--outcome-id", "outcome-a", "--run-id", run.runId, "--repo-root", repoRoot, "--json"], {
      cwd: repoRoot,
      env: { ...process.env, RELAY_HOME: relayHome, RELAY_ORCA_RUNS_ROOT: runsRoot, RELAY_MANIFEST_LOCK_STALE_MS: "1" },
    });
    assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.body)}`);
    assert.equal(result.body.result, "attached");
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
