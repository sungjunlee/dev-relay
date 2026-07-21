"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PROBE_JS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "probe-orca.js");
const {
  resolveOrcaBin,
  isRunnableFile,
  runMain,
  emptyResult,
  MACOS_BUNDLE_FALLBACK,
  JSON_KEYS,
  SMOKE_TITLE_MARKER,
  REASONS,
} = require(PROBE_JS);
const {
  installFakeOrca,
  readyStatus,
  emptyTaskList,
  emptyGateList,
  DEFAULT_RUNTIME_ID,
  DEFAULT_LIVE_AGENT_HANDLE,
  VALID_TASK_STATUSES,
} = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));
const { probe } = require(PROBE_JS);
const { programSegment, resolveRepoContext } = require(path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "receipt-io.js"));
const { RECEIPT_NOTE } = require(path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "lib", "receipt.js"));
const { canonicalIntegrationQuestion } = require(path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "lib", "integration-lifecycle.js"));
const { verificationBinding, sha256 } = require(path.join(REPO_ROOT, "skills", "relay-orca", "scripts", "lib", "integration-evidence.js"));

const READ_ONLY_SUBCOMMANDS = new Set(["status", "task-list", "gate-list"]);
const FORBIDDEN_DEFAULT = ["task-create", "task-update", "dispatch", "run", "reset"];
const SMOKE_ARGS = ["--smoke", "--smoke-to", DEFAULT_LIVE_AGENT_HANDLE];

function runProbe(args, env = {}) {
  const result = { status: 0, stdout: "", stderr: "" };
  try {
    result.stdout = execFileSync(process.execPath, [PROBE_JS, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
  } catch (error) {
    result.status = error.status;
    result.stdout = error.stdout ? String(error.stdout) : "";
    result.stderr = error.stderr ? String(error.stderr) : "";
  }
  return result;
}

function parseJson(stdout) {
  return JSON.parse(String(stdout));
}

function assertExactKeys(body) {
  assert.deepEqual(Object.keys(body).sort(), [...JSON_KEYS].sort());
}

function assertNoPoison(fake) {
  assert.equal(fake.readPoison(), null, "reset poison marker must never be written");
}

function assertReadOnlyLog(logLines) {
  const tokens = logLines.join(" ");
  for (const forbidden of FORBIDDEN_DEFAULT) {
    assert.equal(
      tokens.includes(forbidden),
      false,
      `default mode must not invoke ${forbidden}; log=${JSON.stringify(logLines)}`,
    );
  }
  for (const line of logLines) {
    const parts = line.split(" ");
    // status | orchestration task-list | orchestration gate-list
    if (parts[0] === "status") continue;
    if (parts[0] === "orchestration" && READ_ONLY_SUBCOMMANDS.has(parts[1])) continue;
    assert.fail(`unexpected default-mode invocation: ${line}`);
  }
}

function historicalContextFixture({ programId = "prior-program-1", taskId = "prior-task-1" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-prior-context-"));
  const repo = resolveRepoContext({ repoRootOverride: REPO_ROOT });
  const outcomeId = "integration";
  const marker = `relay-orca: ${programSegment(programId)}/${outcomeId}`;
  const checkRef = "full-suite";
  const verification = verificationBinding({
    input_sha256: sha256("prior-input"),
    result_sha256: sha256("prior-result"),
    passed: true,
  });
  const program = {
    id: programId,
    runtime_id: DEFAULT_RUNTIME_ID,
    exit_gates: [`integration:${checkRef}`],
    integration_evidence_version: 1,
    integration_evidence: [{ check_ref: checkRef, program_id: programId, runtime_id: DEFAULT_RUNTIME_ID, verification }],
    outcomes: [{ id: outcomeId, task_kind: "integration_gate", accepted_outcomes: ["passed"] }],
  };
  const task = {
    outcome_id: outcomeId,
    task_id: `plan-${outcomeId}`,
    kind: "integration_gate",
    wave: 1,
    orca_task_id: taskId,
    dispatch_id: `dispatch-${taskId}`,
    assignee: DEFAULT_LIVE_AGENT_HANDLE,
    relay_ids: { request: null, run: null, fleet: null },
  };
  const receipt = {
    schema: 1,
    program_id: programId,
    source: path.join(root, "accepted-program.json"),
    repo: { slug: repo.slug, root: repo.root },
    runtime_id: DEFAULT_RUNTIME_ID,
    tasks: [task],
    terminals_created: [],
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
    note: RECEIPT_NOTE,
  };
  const durable = {
    [outcomeId]: {
      outcome_id: outcomeId,
      runtime_id: DEFAULT_RUNTIME_ID,
      integration: { passed: true },
    },
  };
  const generic = {
    [checkRef]: {
      schema: 1,
      program_id: programId,
      runtime_id: DEFAULT_RUNTIME_ID,
      check_ref: checkRef,
      verification,
      evidence: "prior integration evidence",
    },
  };
  const context = {
    schema: 1,
    // Deliberately false: the probe must ignore this claim and recompute Leaf 1.
    success: false,
    repo_root: REPO_ROOT,
    accepted_program: { path: path.join(root, "accepted-program.json") },
    canonical_receipt: { path: path.join(root, "receipt.json") },
    trusted_evidence: {
      durable_outcomes: { path: path.join(root, "durable.json") },
      generic_integration: { path: path.join(root, "generic.json") },
    },
  };
  fs.writeFileSync(path.join(root, "accepted-program.json"), JSON.stringify(program), "utf8");
  fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt), "utf8");
  fs.writeFileSync(path.join(root, "durable.json"), JSON.stringify(durable), "utf8");
  fs.writeFileSync(path.join(root, "generic.json"), JSON.stringify(generic), "utf8");
  fs.writeFileSync(path.join(root, "context.json"), JSON.stringify(context), "utf8");
  return {
    root,
    contextPath: path.join(root, "context.json"),
    program,
    receipt,
    task: { id: taskId, task_title: marker, display_name: marker, status: "completed" },
    gate: {
      id: `gate-${taskId}`,
      task_id: taskId,
      question: canonicalIntegrationQuestion(programId, outcomeId, programSegment),
      options: ["passed", "failed"],
      status: "passed",
      resolution: "passed",
    },
  };
}

function runProbeWithPriorContext(contextPath, fake, overrides = {}) {
  const result = emptyResult(false);
  let error = null;
  try {
    probe({
      orcaBin: fake.orcaPath,
      isRunnableFile: () => true,
      priorProgramContexts: [contextPath],
      repoRoot: REPO_ROOT,
      ...overrides,
      _result: result,
    });
  } catch (caught) {
    error = caught;
  }
  return { result, error };
}

// AC8 (DC #8): mutation / foreign-adoption / worktree / terminal tokens the strictly
// read-only historical-admission path must NEVER emit. Kept in lock-step with the fixture's
// poisonMutations surface so a test proves the whole matrix, not a subset.
const FORBIDDEN_ADMISSION_TOKENS = [
  "reset",
  "task-create",
  "task-update",
  "task-delete",
  "gate-create",
  "gate-resolve",
  "gate-delete",
  "dispatch",
  "worktree",
  "terminal",
  "adopt",
];

// Content-hash every file in a directory so a before/after comparison proves the read-only
// admission path made ZERO filesystem writes (input byte identity, DC #8).
function snapshotDir(dir) {
  const map = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) map[name] = sha256(fs.readFileSync(full, "utf8"));
  }
  return map;
}

// Tripwire `gh` and `orca` on PATH: admission is given the fake via --orca-bin and never
// shells out to GitHub, so IF it ever fell through to a real binary the marker file proves
// it. Neither marker may exist after a read-only admission (DC #8: never invoke real orca/gh).
function installRealBinaryPoison() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-real-bin-poison-"));
  for (const name of ["gh", "orca"]) {
    const marker = path.join(dir, `${name}.invoked`);
    fs.writeFileSync(
      path.join(dir, name),
      `#!/bin/sh\necho REAL_${name}_INVOKED > ${JSON.stringify(marker)}\nexit 97\n`,
      "utf8",
    );
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return {
    dir,
    ghInvoked: () => fs.existsSync(path.join(dir, "gh.invoked")),
    orcaInvoked: () => fs.existsSync(path.join(dir, "orca.invoked")),
    pathWith: () => `${dir}${path.delimiter}${process.env.PATH || ""}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// D3 binary resolution
// ---------------------------------------------------------------------------

test("D3: PATH lookup resolves the fixture orca", () => {
  const fake = installFakeOrca();
  try {
    const resolved = resolveOrcaBin({ pathEnv: process.env.PATH });
    assert.equal(resolved.path, fake.orcaPath);
    assert.equal(resolved.source, "path");
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D3: --orca-bin override wins over PATH", () => {
  const onPath = installFakeOrca({}, { prefix: "orca-path-" });
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-override-"));
  const overrideBin = path.join(overrideDir, "orca-override");
  fs.copyFileSync(onPath.orcaPath, overrideBin);
  fs.chmodSync(overrideBin, 0o755);
  // Point override fake at its own scenario/log via rewriting — simpler: use
  // resolveOrcaBin unit path + CLI with --orca-bin.
  try {
    const resolved = resolveOrcaBin({
      orcaBinOverride: overrideBin,
      pathEnv: process.env.PATH,
    });
    assert.equal(resolved.path, overrideBin);
    assert.equal(resolved.source, "override");

    const result = runProbe(["--json", "--orca-bin", overrideBin], {
      PATH: process.env.PATH,
    });
    // Override binary is a copy without scenario env — the script embeds absolute
    // scenario path from install time, so the copied binary still works if we
    // copy from a second install that shares... Actually copyFileSync of the
    // script keeps the original scenarioPath constants, so it still works.
    assert.equal(result.status, 0);
    const body = parseJson(result.stdout);
    assert.equal(body.orca_bin, overrideBin);
    assert.equal(body.admitted, true);
    assertNoPoison(onPath);
  } finally {
    onPath.restore();
    fs.rmSync(overrideDir, { recursive: true, force: true });
  }
});

test("D3: bundle-fallback branch without a real /Applications install", () => {
  const seen = [];
  const bundlePath = MACOS_BUNDLE_FALLBACK;
  const resolved = resolveOrcaBin({
    orcaBinOverride: null,
    pathEnv: "",
    isRunnableFile: (candidate) => {
      seen.push(candidate);
      return candidate === bundlePath;
    },
  });
  assert.equal(resolved.path, bundlePath);
  assert.equal(resolved.source, "bundle");
  assert.ok(seen.includes(bundlePath));
});

test("D3: all resolution branches miss → BINARY_NOT_FOUND exit 30", () => {
  // Driven in-process with an injected existsSync so the macOS bundle fallback
  // deterministically misses even on a host that has a real Orca install — a
  // missing --orca-bin override now falls through, so the bundle must be stubbed.
  const prevExit = process.exitCode;
  try {
    const result = runMain(["--json", "--orca-bin", "/tmp/definitely-missing-orca-bin"], {
      isRunnableFile: () => false,
      pathEnv: "/tmp/empty-orca-path-dir-that-does-not-provide-orca",
    });
    assert.equal(process.exitCode, REASONS.BINARY_NOT_FOUND);
    assertExactKeys(result);
    assert.equal(result.admitted, false);
    assert.equal(result.orca_bin, null);
    assert.equal(result.blocking_reasons[0].reason_code, "BINARY_NOT_FOUND");
  } finally {
    process.exitCode = prevExit;
  }
});

test("Finding 1: missing --orca-bin override falls through to a PATH orca (first-hit order)", () => {
  const fake = installFakeOrca();
  try {
    // Unit: a missing override is a miss, not a short-circuit → resolves via PATH.
    const resolved = resolveOrcaBin({
      orcaBinOverride: "/tmp/definitely-missing-orca-override",
      pathEnv: process.env.PATH,
    });
    assert.equal(resolved.path, fake.orcaPath);
    assert.equal(resolved.source, "path");

    // End-to-end: probe admits using the PATH binary and reports it as orca_bin.
    const result = runProbe(
      ["--json", "--orca-bin", "/tmp/definitely-missing-orca-override"],
      { PATH: process.env.PATH },
    );
    assert.equal(result.status, 0);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, true);
    assert.equal(body.orca_bin, fake.orcaPath);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("Finding 4: --orca-bin override at a DIRECTORY falls through to a runnable PATH orca; probe admits", () => {
  const fake = installFakeOrca(); // real chmod 0o755 orca prepended to PATH
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-override-dir-"));
  try {
    // Unit: a directory is not a regular executable file → override MISS → PATH wins.
    const resolved = resolveOrcaBin({
      orcaBinOverride: overrideDir,
      pathEnv: process.env.PATH,
    });
    assert.equal(resolved.path, fake.orcaPath);
    assert.equal(resolved.source, "path");

    // End-to-end: probe resolves the PATH binary and admits.
    const result = runProbe(["--json", "--orca-bin", overrideDir], {
      PATH: process.env.PATH,
    });
    assert.equal(result.status, 0);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, true);
    assert.equal(body.orca_bin, fake.orcaPath);
    assertNoPoison(fake);
  } finally {
    fake.restore();
    fs.rmSync(overrideDir, { recursive: true, force: true });
  }
});

test("Finding 4: non-executable regular orca on PATH, nothing else → BINARY_NOT_FOUND exit 30", () => {
  // A regular file that is not executable is a MISS. The real isRunnableFile
  // predicate rejects it; the bundle fallback is stubbed to miss so the result
  // is deterministic even on a host with a real /Applications Orca install.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-nonexec-"));
  const nonExec = path.join(dir, "orca");
  fs.writeFileSync(nonExec, "#!/bin/sh\necho hi\n", "utf-8");
  fs.chmodSync(nonExec, 0o644); // regular file, NOT executable
  const prevExit = process.exitCode;
  try {
    // Unit: the real predicate treats a non-executable regular file as a miss.
    assert.equal(isRunnableFile(nonExec), false);

    const result = runMain(["--json"], {
      pathEnv: dir,
      isRunnableFile: (p) => (p === MACOS_BUNDLE_FALLBACK ? false : isRunnableFile(p)),
    });
    assert.equal(process.exitCode, REASONS.BINARY_NOT_FOUND);
    assertExactKeys(result);
    assert.equal(result.admitted, false);
    assert.equal(result.orca_bin, null);
    assert.equal(result.blocking_reasons[0].reason_code, "BINARY_NOT_FOUND");
  } finally {
    process.exitCode = prevExit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D4 readiness
// ---------------------------------------------------------------------------

test("D4: app.running false → RUNTIME_NOT_READY exit 31", () => {
  const status = readyStatus();
  status.result.app.running = false;
  const fake = installFakeOrca({ status });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.RUNTIME_NOT_READY);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "RUNTIME_NOT_READY");
    assert.equal(body.runtime_ready, false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test('D4: runtime.state ≠ "ready" → RUNTIME_NOT_READY exit 31', () => {
  const status = readyStatus();
  status.result.runtime.state = "starting";
  const fake = installFakeOrca({ status });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.RUNTIME_NOT_READY);
    assert.equal(parseJson(result.stdout).blocking_reasons[0].reason_code, "RUNTIME_NOT_READY");
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D4: missing/empty runtimeId → RUNTIME_NOT_READY exit 31", () => {
  const status = readyStatus();
  status.result.runtime.runtimeId = "";
  const fake = installFakeOrca({ status });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.RUNTIME_NOT_READY);
    assert.equal(parseJson(result.stdout).blocking_reasons[0].reason_code, "RUNTIME_NOT_READY");
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("Finding 1: non-zero status exit with ready-shaped stdout → RUNTIME_NOT_READY exit 31", () => {
  // status prints a fully ready-shaped JSON body but exits 3: a failed readiness
  // command must never admit, regardless of what its (possibly cached) stdout claims.
  const fake = installFakeOrca({ statusExit: 3 });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.RUNTIME_NOT_READY);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.runtime_ready, false);
    const reason = body.blocking_reasons[0];
    assert.equal(reason.reason_code, "RUNTIME_NOT_READY");
    assert.match(reason.message, /exit 3/);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// D5 orchestration availability
// ---------------------------------------------------------------------------

test("D5: orchestration unknown/non-zero/ok:false → ORCHESTRATION_UNAVAILABLE exit 32", () => {
  const cases = [
    { taskListExit: 1, taskListStderr: "Unknown command: orchestration" },
    { taskList: { id: "x", ok: false, result: { tasks: [], count: 0 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } } },
  ];
  for (const overrides of cases) {
    const fake = installFakeOrca(overrides);
    try {
      const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
      assert.equal(result.status, REASONS.ORCHESTRATION_UNAVAILABLE);
      assert.equal(
        parseJson(result.stdout).blocking_reasons[0].reason_code,
        "ORCHESTRATION_UNAVAILABLE",
      );
      assertNoPoison(fake);
    } finally {
      fake.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// D4/D5 malformed
// ---------------------------------------------------------------------------

test("D4/D5: unparseable status AND shape-invalid task-list → MALFORMED_OUTPUT exit 33", () => {
  const fakeUnparseable = installFakeOrca({ statusStdout: "NOT-JSON{{{", status: null });
  try {
    const result = runProbe(["--json", "--orca-bin", fakeUnparseable.orcaPath]);
    assert.equal(result.status, REASONS.MALFORMED_OUTPUT);
    assert.equal(parseJson(result.stdout).blocking_reasons[0].reason_code, "MALFORMED_OUTPUT");
    assertNoPoison(fakeUnparseable);
  } finally {
    fakeUnparseable.restore();
  }

  const badTaskList = {
    id: "x",
    ok: true,
    result: { tasks: "not-an-array", count: 0 },
    _meta: { runtimeId: DEFAULT_RUNTIME_ID },
  };
  const fakeShape = installFakeOrca({ taskList: badTaskList });
  try {
    const result = runProbe(["--json", "--orca-bin", fakeShape.orcaPath]);
    assert.equal(result.status, REASONS.MALFORMED_OUTPUT);
    assert.equal(parseJson(result.stdout).blocking_reasons[0].reason_code, "MALFORMED_OUTPUT");
    assertNoPoison(fakeShape);
  } finally {
    fakeShape.restore();
  }
});

// ---------------------------------------------------------------------------
// D6 existing state / ambiguous
// ---------------------------------------------------------------------------

test("D6: active tasks count > 0 → EXISTING_ORCHESTRATION_STATE exit 34", () => {
  const fake = installFakeOrca({
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [{ id: "pre", status: "pending" }], count: 1 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.EXISTING_ORCHESTRATION_STATE);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "EXISTING_ORCHESTRATION_STATE");
    assert.match(body.blocking_reasons[0].message, /active_tasks=1/);
    assert.match(body.blocking_reasons[0].message, /gates=0/);
    assert.equal(body.admitted, false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D6: historical completed/failed tasks do not brick admission", () => {
  const fake = installFakeOrca({
    taskList: {
      id: "x",
      ok: true,
      result: {
        tasks: [
          { id: "old-failed", status: "failed" },
          { id: "old-done", status: "completed" },
        ],
        count: 2,
      },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, 0);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, true);
    assert.deepEqual(body.existing_state, { tasks: 0, gates: 0 });
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D6: unknown task status → AMBIGUOUS_GLOBAL_STATE exit 35 (fail-closed)", () => {
  const fake = installFakeOrca({
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [{ id: "weird", status: "cancelled" }], count: 1 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "AMBIGUOUS_GLOBAL_STATE");
    assert.match(body.blocking_reasons[0].message, /unknown status/);
    assert.equal(body.admitted, false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D6: task missing status → AMBIGUOUS_GLOBAL_STATE exit 35 (fail-closed)", () => {
  const fake = installFakeOrca({
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [{ id: "no-status" }], count: 1 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "AMBIGUOUS_GLOBAL_STATE");
    assert.match(body.blocking_reasons[0].message, /lacks a non-empty status/);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D6: mixed terminal + live tasks → EXISTING_ORCHESTRATION_STATE counts only live", () => {
  const fake = installFakeOrca({
    taskList: {
      id: "x",
      ok: true,
      result: {
        tasks: [
          { id: "done", status: "completed" },
          { id: "live", status: "blocked" },
          { id: "failed-old", status: "failed" },
        ],
        count: 3,
      },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.EXISTING_ORCHESTRATION_STATE);
    const body = parseJson(result.stdout);
    assert.match(body.blocking_reasons[0].message, /active_tasks=1/);
    assert.equal(body.existing_state.tasks, 1);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D6: gates count > 0 → EXISTING_ORCHESTRATION_STATE exit 34", () => {
  const fake = installFakeOrca({
    gateList: {
      id: "x",
      ok: true,
      result: { gates: [{ id: "g1" }, { id: "g2" }], count: 2 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.EXISTING_ORCHESTRATION_STATE);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "EXISTING_ORCHESTRATION_STATE");
    assert.match(body.blocking_reasons[0].message, /tasks=0/);
    assert.match(body.blocking_reasons[0].message, /gates=2/);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// #1021 reset-free historical admission (red before the admission filter)
// ---------------------------------------------------------------------------

test("#1021 verified prior-program context admits its completed task and passed gate", () => {
  const history = historicalContextFixture();
  const fake = installFakeOrca({
    poisonMutations: true,
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [history.task], count: 1 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
    gateList: {
      id: "x",
      ok: true,
      result: { gates: [history.gate], count: 1 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const { result, error } = runProbeWithPriorContext(history.contextPath, fake);
    assert.equal(error, null, "a valid locator must be recomputed and admitted");
    assert.equal(result.admitted, true);
    assert.deepEqual(result.existing_state, { tasks: 0, gates: 0 });
    assertReadOnlyLog(fake.readLog());
    assertNoPoison(fake);
  } finally {
    fake.restore();
    fs.rmSync(history.root, { recursive: true, force: true });
  }
});

test("#1021 probe CLI accepts repeatable context paths and recomputes proof", () => {
  const history = historicalContextFixture({ programId: "prior-program-cli" });
  const fake = installFakeOrca({
    poisonMutations: true,
    taskList: { id: "x", ok: true, result: { tasks: [history.task], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
    gateList: { id: "x", ok: true, result: { gates: [history.gate], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
  });
  try {
    const result = runProbe([
      "--json",
      "--orca-bin",
      fake.orcaPath,
      "--repo-root",
      REPO_ROOT,
      "--prior-program-context",
      history.contextPath,
      "--prior-program-context",
      history.contextPath,
    ]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.match(body.blocking_reasons[0].message, /duplicated/);
    assertNoPoison(fake);
  } finally {
    fake.restore();
    fs.rmSync(history.root, { recursive: true, force: true });
  }
});

test("#1021 prior-program contexts never let a foreign terminal row hide behind a verified proof", () => {
  const history = historicalContextFixture({ programId: "prior-program-foreign" });
  const foreign = { id: "foreign-terminal", task_title: "foreign", display_name: "foreign", status: "completed" };
  const fake = installFakeOrca({
    poisonMutations: true,
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [history.task, foreign], count: 2 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
    gateList: {
      id: "x",
      ok: true,
      result: { gates: [history.gate], count: 1 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const { result, error } = runProbeWithPriorContext(history.contextPath, fake);
    assert.equal(error && error.reasonCode, "EXISTING_ORCHESTRATION_STATE");
    assert.equal(result.admitted, false);
    assert.match(error.message, /active_tasks=1/);
    assertNoPoison(fake);
  } finally {
    fake.restore();
    fs.rmSync(history.root, { recursive: true, force: true });
  }
});

test("#1021 failed, missing-id, and duplicate rows are never historical exemptions", () => {
  const scenarios = [
    {
      label: "failed",
      task: (history) => ({ ...history.task, status: "failed" }),
      expected: "EXISTING_ORCHESTRATION_STATE",
    },
    {
      label: "missing id",
      task: (history) => ({ ...history.task, id: "" }),
      expected: "AMBIGUOUS_GLOBAL_STATE",
    },
    {
      label: "duplicate",
      task: (history) => [history.task, { ...history.task }],
      expected: "AMBIGUOUS_GLOBAL_STATE",
    },
  ];
  for (const scenario of scenarios) {
    const history = historicalContextFixture({ programId: `prior-program-${scenario.label.replace(/ /g, "-")}` });
    const tasks = scenario.task(history);
    const rows = Array.isArray(tasks) ? tasks : [tasks];
    const fake = installFakeOrca({
      poisonMutations: true,
      taskList: {
        id: "x",
        ok: true,
        result: { tasks: rows, count: rows.length },
        _meta: { runtimeId: DEFAULT_RUNTIME_ID },
      },
      gateList: {
        id: "x",
        ok: true,
        result: { gates: [history.gate], count: 1 },
        _meta: { runtimeId: DEFAULT_RUNTIME_ID },
      },
    });
    try {
      const { result, error } = runProbeWithPriorContext(history.contextPath, fake);
      assert.equal(error && error.reasonCode, scenario.expected, scenario.label);
      assert.equal(result.admitted, false, scenario.label);
      assertNoPoison(fake);
    } finally {
      fake.restore();
      fs.rmSync(history.root, { recursive: true, force: true });
    }
  }
});

test("#1021 missing, duplicate, and malformed contexts fail closed before any mutation", () => {
  const history = historicalContextFixture({ programId: "prior-program-context-errors" });
  const fake = installFakeOrca({
    poisonMutations: true,
    taskList: { id: "x", ok: true, result: { tasks: [history.task], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
    gateList: { id: "x", ok: true, result: { gates: [history.gate], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
  });
  const malformedPath = path.join(history.root, "malformed.json");
  const crossRepoPath = path.join(history.root, "cross-repo.json");
  fs.writeFileSync(malformedPath, JSON.stringify({ schema: 1 }), "utf8");
  // Portable cross-repo fixture: a per-test temporary git repo whose canonical slug/root differ
  // from the target repository on ANY host — never a host-specific absolute path. The context
  // points a valid, loadable locator at this unrelated checkout, so admission fails closed on the
  // repo-identity mismatch (→ AMBIGUOUS_GLOBAL_STATE) rather than depending on a path only present
  // on one developer's machine.
  const crossRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-cross-repo-"));
  execFileSync("git", ["-C", crossRepoRoot, "init", "-q"], { stdio: "ignore" });
  fs.writeFileSync(crossRepoPath, JSON.stringify({
    ...JSON.parse(fs.readFileSync(history.contextPath, "utf8")),
    repo_root: crossRepoRoot,
  }), "utf8");
  try {
    for (const inputs of [
      [path.join(history.root, "missing.json")],
      [history.contextPath, history.contextPath],
      [malformedPath],
      [crossRepoPath],
    ]) {
      const { result, error } = runProbeWithPriorContext(inputs[0], fake, {
        priorProgramContexts: inputs,
      });
      assert.equal(error && error.reasonCode, "AMBIGUOUS_GLOBAL_STATE");
      assert.equal(result.admitted, false);
      assertNoPoison(fake);
    }
  } finally {
    fake.restore();
    fs.rmSync(history.root, { recursive: true, force: true });
    fs.rmSync(crossRepoRoot, { recursive: true, force: true });
  }
});

test("#1021 R5 finding 1: a FAILED prior context that claims the SAME physical task as a PASSING one is AMBIGUOUS (exit 35), never masked", () => {
  // Program A's proof passes and would exempt the live `shared-task` row. Program B's proof FAILS
  // (its marker/canonical gate do not match the shared live rows) yet its recomputed proof still
  // CLAIMS the same physical `shared-task`. A passing proof must never mask a live row an unproven
  // program also claims (DC #6), so admission fails closed AMBIGUOUS_GLOBAL_STATE with zero
  // mutation — it must NOT silently admit by letting A's exemption cover B's unproven claim.
  const passing = historicalContextFixture({ programId: "prior-program-a-overlap", taskId: "shared-task" });
  const failing = historicalContextFixture({ programId: "prior-program-b-overlap", taskId: "shared-task" });
  const beforePassing = snapshotDir(passing.root);
  const beforeFailing = snapshotDir(failing.root);
  const fake = installFakeOrca({
    poisonMutations: true,
    // The live snapshot carries A's completed task + passed gate; B is recomputed against the SAME
    // rows, so B fails marker/canonical checks while still resolving the shared physical task.
    taskList: { id: "x", ok: true, result: { tasks: [passing.task], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
    gateList: { id: "x", ok: true, result: { gates: [passing.gate], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
  });
  try {
    const { result, error } = runProbeWithPriorContext(passing.contextPath, fake, {
      priorProgramContexts: [passing.contextPath, failing.contextPath],
    });
    assert.equal(error && error.reasonCode, "AMBIGUOUS_GLOBAL_STATE");
    assert.equal(error.exitCode, REASONS.AMBIGUOUS_GLOBAL_STATE);
    assert.equal(result.admitted, false);
    // The exit-35 path nulls the post-filter counts (no classifiable blocking counts are reported).
    assert.deepEqual(result.existing_state, { tasks: null, gates: null });
    assertReadOnlyLog(fake.readLog());
    assertNoPoison(fake);
    assert.deepEqual(snapshotDir(passing.root), beforePassing, "the ambiguous overlap path must not mutate any input file");
    assert.deepEqual(snapshotDir(failing.root), beforeFailing, "the ambiguous overlap path must not mutate any input file");
  } finally {
    fake.restore();
    fs.rmSync(passing.root, { recursive: true, force: true });
    fs.rmSync(failing.root, { recursive: true, force: true });
  }
});

test("#1021 R5 finding 1: two FAILED prior contexts that claim the SAME physical task are AMBIGUOUS (exit 35), zero mutation", () => {
  // Neither proof passes (both lost their canonical gate), so neither grants an exemption — but
  // both recomputed proofs still CLAIM the same physical `shared-task-2` row. Two unproven programs
  // contending for one live row is unclassifiable, so admission fails closed AMBIGUOUS_GLOBAL_STATE
  // (exit 35) with zero mutation, never silently reported as exit-34 residue.
  const first = historicalContextFixture({ programId: "prior-program-c-overlap", taskId: "shared-task-2" });
  const second = historicalContextFixture({ programId: "prior-program-d-overlap", taskId: "shared-task-2" });
  const beforeFirst = snapshotDir(first.root);
  const beforeSecond = snapshotDir(second.root);
  const fake = installFakeOrca({
    poisonMutations: true,
    // The live task is present (so both proofs resolve and CLAIM the shared physical row) but the
    // gate is gone, so BOTH proofs fail PROOF_GATE_MISSING — neither can grant an exemption.
    taskList: { id: "x", ok: true, result: { tasks: [first.task], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
    gateList: { id: "x", ok: true, result: { gates: [], count: 0 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
  });
  try {
    const { result, error } = runProbeWithPriorContext(first.contextPath, fake, {
      priorProgramContexts: [first.contextPath, second.contextPath],
    });
    assert.equal(error && error.reasonCode, "AMBIGUOUS_GLOBAL_STATE");
    assert.equal(error.exitCode, REASONS.AMBIGUOUS_GLOBAL_STATE);
    assert.equal(result.admitted, false);
    assert.deepEqual(result.existing_state, { tasks: null, gates: null });
    assertReadOnlyLog(fake.readLog());
    assertNoPoison(fake);
    assert.deepEqual(snapshotDir(first.root), beforeFirst, "the ambiguous overlap path must not mutate any input file");
    assert.deepEqual(snapshotDir(second.root), beforeSecond, "the ambiguous overlap path must not mutate any input file");
  } finally {
    fake.restore();
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});

test("#1021 R5 finding 2: the historical reject message is bounded before it is surfaced", () => {
  // The AMBIGUOUS overlap message embeds a subprocess-derived physical id. An adversarial or wedged
  // CLI could inflate that id without bound; admission must render `history.message` through
  // boundedExcerpt like every other reject call site, so a blocking message can never be inflated
  // or line-injected past the D8 bound (EXCERPT_LIMIT = 256).
  const longTaskId = "s".repeat(400);
  const passing = historicalContextFixture({ programId: "prior-program-a-bounded", taskId: longTaskId });
  const failing = historicalContextFixture({ programId: "prior-program-b-bounded", taskId: longTaskId });
  const fake = installFakeOrca({
    poisonMutations: true,
    taskList: { id: "x", ok: true, result: { tasks: [passing.task], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
    gateList: { id: "x", ok: true, result: { gates: [passing.gate], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
  });
  try {
    const { result, error } = runProbeWithPriorContext(passing.contextPath, fake, {
      priorProgramContexts: [passing.contextPath, failing.contextPath],
    });
    assert.equal(error && error.reasonCode, "AMBIGUOUS_GLOBAL_STATE");
    assert.equal(result.admitted, false);
    // The raw id is >256 chars; the surfaced message must be truncated to the bounded excerpt and
    // must never carry the full unbounded id.
    assert.ok(error.message.length <= 256, `reject message must be bounded, got length ${error.message.length}`);
    assert.ok(!error.message.includes(longTaskId), "the full unbounded id must not appear in the surfaced message");
    assertNoPoison(fake);
  } finally {
    fake.restore();
    fs.rmSync(passing.root, { recursive: true, force: true });
    fs.rmSync(failing.root, { recursive: true, force: true });
  }
});

test("#1021 a verified completed task whose live canonical gate is MISSING classifies as EXISTING_ORCHESTRATION_STATE (34), not AMBIGUOUS (35)", () => {
  // The mapped completed task is still present, but its canonical gate has vanished from the
  // live gate-list. Leaf 1 recomputes PROOF_GATE_MISSING — a KNOWN blocking lifecycle residue
  // (a missing gate is no less blocking than a pending/failed one). Admission must therefore
  // classify the now-unproven completed row through exit 34 with post-filter counts, never
  // throw PriorProgramContextError → AMBIGUOUS_GLOBAL_STATE (35) with existing_state {null,null}.
  const history = historicalContextFixture({ programId: "prior-program-gate-missing" });
  const fake = installFakeOrca({
    poisonMutations: true,
    taskList: { id: "x", ok: true, result: { tasks: [history.task], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
    gateList: { id: "x", ok: true, result: { gates: [], count: 0 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
  });
  try {
    const { result, error } = runProbeWithPriorContext(history.contextPath, fake);
    assert.equal(error && error.reasonCode, "EXISTING_ORCHESTRATION_STATE");
    assert.equal(error.exitCode, REASONS.EXISTING_ORCHESTRATION_STATE);
    assert.equal(result.admitted, false);
    assert.match(error.message, /active_tasks=1/);
    // Post-filter counts are reported, NOT nulled out as they are on the exit-35 path.
    assert.deepEqual(result.existing_state, { tasks: 1, gates: 0 });
    assertReadOnlyLog(fake.readLog());
    assertNoPoison(fake);
  } finally {
    fake.restore();
    fs.rmSync(history.root, { recursive: true, force: true });
  }
});

test("#1021 R3 finding 1: a mixed-failure proof (blocking + unclassifiable co-failure) is ambiguous → exit 35, never kept as exit-34 residue", () => {
  // The retained runtime lost BOTH the mapped task and its canonical gate: Leaf 1 recomputes
  // a proof whose failures MIX a known blocking residue (PROOF_GATE_MISSING) with an
  // unclassifiable co-failure (PROOF_TASK_MISSING). Ambiguity must dominate — the whole
  // context is unclassifiable — so admission throws AMBIGUOUS_GLOBAL_STATE (exit 35) with the
  // counts nulled, NEVER retaining it as exit-34 classifiable blocking on the strength of the
  // primary reason code (PROOF_GATE_MISSING) alone. Every explicit input stays byte-identical.
  const history = historicalContextFixture({ programId: "prior-program-mixed-failure" });
  const before = snapshotDir(history.root);
  const fake = installFakeOrca({
    poisonMutations: true,
    taskList: { id: "x", ok: true, result: { tasks: [], count: 0 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
    gateList: { id: "x", ok: true, result: { gates: [], count: 0 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
  });
  try {
    const { result, error } = runProbeWithPriorContext(history.contextPath, fake);
    assert.equal(error && error.reasonCode, "AMBIGUOUS_GLOBAL_STATE");
    assert.equal(error.exitCode, REASONS.AMBIGUOUS_GLOBAL_STATE);
    assert.equal(result.admitted, false);
    // The exit-35 path nulls the post-filter counts (it never reports classifiable blocking counts).
    assert.deepEqual(result.existing_state, { tasks: null, gates: null });
    // Zero mutation + byte-identity of every explicit input on the ambiguous failure path.
    assertReadOnlyLog(fake.readLog());
    assertNoPoison(fake);
    assert.deepEqual(snapshotDir(history.root), before, "the ambiguous failure path must not mutate any input file");
  } finally {
    fake.restore();
    fs.rmSync(history.root, { recursive: true, force: true });
  }
});

test("#1021 R3 finding 1 boundary: an all-blocking multi-failure proof is STILL retained as exit-34 classifiable residue", () => {
  // Two blocking residues co-occur — the mapped task is active (PROOF_TASK_ACTIVE) AND its
  // canonical gate has vanished (PROOF_GATE_MISSING). EVERY failure code is a known blocking
  // lifecycle code, so the fix must NOT over-throw: the context stays classifiable and
  // admission reports it through exit 34 (EXISTING_ORCHESTRATION_STATE) with post-filter
  // counts, not the ambiguous exit-35 path.
  const history = historicalContextFixture({ programId: "prior-program-all-blocking" });
  const fake = installFakeOrca({
    poisonMutations: true,
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [{ ...history.task, status: "dispatched" }], count: 1 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
    gateList: { id: "x", ok: true, result: { gates: [], count: 0 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
  });
  try {
    const { result, error } = runProbeWithPriorContext(history.contextPath, fake);
    assert.equal(error && error.reasonCode, "EXISTING_ORCHESTRATION_STATE");
    assert.equal(error.exitCode, REASONS.EXISTING_ORCHESTRATION_STATE);
    assert.equal(result.admitted, false);
    assert.match(error.message, /active_tasks=1/);
    assert.deepEqual(result.existing_state, { tasks: 1, gates: 0 });
    assertReadOnlyLog(fake.readLog());
    assertNoPoison(fake);
  } finally {
    fake.restore();
    fs.rmSync(history.root, { recursive: true, force: true });
  }
});

test("#1021 AC8: task-delete and foreign adoption (adopt) are poisoned on the read-only admission fixture", () => {
  const fake = installFakeOrca({ poisonMutations: true });
  try {
    for (const argv of [
      ["orchestration", "task-delete", "--id", "t1", "--json"],
      ["orchestration", "adopt", "--run", "r1", "--json"],
    ]) {
      fs.rmSync(fake.poisonPath, { force: true });
      let status = 0;
      try {
        execFileSync(fake.orcaPath, argv, { stdio: "pipe" });
      } catch (error) {
        status = error.status;
      }
      assert.equal(status, 98, `${argv.join(" ")} must hard-fail the read-only fixture`);
      assert.match(fake.readPoison(), /MUTATION_INVOKED/);
    }
  } finally {
    fake.restore();
  }
});

test("#1021 AC8: read-only admission touches no mutating/adoption subcommand, no real gh/orca, and writes nothing", () => {
  const realPoison = installRealBinaryPoison();
  const history = historicalContextFixture({ programId: "prior-program-ac8-readonly" });
  const fake = installFakeOrca(
    {
      poisonMutations: true,
      taskList: { id: "x", ok: true, result: { tasks: [history.task], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
      gateList: { id: "x", ok: true, result: { gates: [history.gate], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
    },
    { prependPath: false },
  );
  const before = snapshotDir(history.root);
  try {
    const result = runProbe(
      ["--json", "--orca-bin", fake.orcaPath, "--repo-root", REPO_ROOT, "--prior-program-context", history.contextPath],
      { PATH: realPoison.pathWith() },
    );
    assert.equal(result.status, 0);
    const body = parseJson(result.stdout);
    assert.equal(body.admitted, true);
    assert.deepEqual(body.existing_state, { tasks: 0, gates: 0 });
    // Neither the real `gh` nor a PATH `orca` was shelled out (only the injected fake ran).
    assert.equal(realPoison.ghInvoked(), false, "real gh must never be invoked by admission");
    assert.equal(realPoison.orcaInvoked(), false, "real/PATH orca must never be invoked when --orca-bin is injected");
    // Only read-only subcommands ran; no mutation/adoption/worktree/terminal token appears.
    assertReadOnlyLog(fake.readLog());
    const tokens = fake.readLog().join(" ");
    FORBIDDEN_ADMISSION_TOKENS.forEach((forbidden) =>
      assert.equal(tokens.includes(forbidden), false, `read-only admission emitted ${forbidden}`),
    );
    assertNoPoison(fake);
    // Zero filesystem writes: every explicit input file is byte-identical and none were added.
    assert.deepEqual(snapshotDir(history.root), before, "read-only admission must not mutate its input files");
  } finally {
    fake.restore();
    realPoison.cleanup();
    fs.rmSync(history.root, { recursive: true, force: true });
  }
});

test("#1021 AC8: a rejected admission leaves every explicit context input byte-identical (zero mutation)", () => {
  const realPoison = installRealBinaryPoison();
  const history = historicalContextFixture({ programId: "prior-program-ac8-identity" });
  // A foreign completed terminal row cannot hide behind the verified proof, so admission
  // rejects with EXISTING_ORCHESTRATION_STATE. Even on this failure path every read input
  // stays byte-identical — the admission surface never writes.
  const foreign = { id: "foreign-terminal", task_title: "foreign", display_name: "foreign", status: "completed" };
  const fake = installFakeOrca(
    {
      poisonMutations: true,
      taskList: { id: "x", ok: true, result: { tasks: [history.task, foreign], count: 2 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
      gateList: { id: "x", ok: true, result: { gates: [history.gate], count: 1 }, _meta: { runtimeId: DEFAULT_RUNTIME_ID } },
    },
    { prependPath: false },
  );
  const before = snapshotDir(history.root);
  try {
    const result = runProbe(
      ["--json", "--orca-bin", fake.orcaPath, "--repo-root", REPO_ROOT, "--prior-program-context", history.contextPath],
      { PATH: realPoison.pathWith() },
    );
    assert.equal(result.status, REASONS.EXISTING_ORCHESTRATION_STATE);
    const body = parseJson(result.stdout);
    assert.equal(body.admitted, false);
    assert.equal(body.blocking_reasons[0].reason_code, "EXISTING_ORCHESTRATION_STATE");
    assert.match(body.blocking_reasons[0].message, /active_tasks=1/);
    // Input byte identity: every explicit context/receipt/evidence file is unchanged.
    assert.deepEqual(snapshotDir(history.root), before, "failed admission must not mutate any input file");
    // No mutation/adoption, no real gh/orca, no poison marker even on the reject path.
    assertReadOnlyLog(fake.readLog());
    const tokens = fake.readLog().join(" ");
    FORBIDDEN_ADMISSION_TOKENS.forEach((forbidden) =>
      assert.equal(tokens.includes(forbidden), false, `rejected admission emitted ${forbidden}`),
    );
    assert.equal(realPoison.ghInvoked(), false);
    assert.equal(realPoison.orcaInvoked(), false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
    realPoison.cleanup();
    fs.rmSync(history.root, { recursive: true, force: true });
  }
});

test("D6: _meta.runtimeId mismatch → AMBIGUOUS_GLOBAL_STATE exit 35", () => {
  const fake = installFakeOrca({
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [], count: 0 },
      _meta: { runtimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    assert.equal(
      parseJson(result.stdout).blocking_reasons[0].reason_code,
      "AMBIGUOUS_GLOBAL_STATE",
    );
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("Finding 5: task-list missing _meta.runtimeId → AMBIGUOUS_GLOBAL_STATE exit 35", () => {
  // Otherwise clean/empty state, but the task-list response carries no
  // _meta.runtimeId. Cross-runtime consistency cannot be established, so a
  // missing id must classify exactly like a mismatch, never a silent pass.
  const fake = installFakeOrca({
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [], count: 0 },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.blocking_reasons[0].reason_code, "AMBIGUOUS_GLOBAL_STATE");
    assert.match(body.blocking_reasons[0].message, /task-list/);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test('Finding 5: gate-list empty-string _meta.runtimeId → AMBIGUOUS_GLOBAL_STATE exit 35', () => {
  // An empty-string runtime id is as unusable as a missing one for establishing
  // that the three responses came from a single runtime.
  const fake = installFakeOrca({
    gateList: {
      id: "x",
      ok: true,
      result: { gates: [], count: 0 },
      _meta: { runtimeId: "" },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.blocking_reasons[0].reason_code, "AMBIGUOUS_GLOBAL_STATE");
    assert.match(body.blocking_reasons[0].message, /gate-list/);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("Finding 6: status response missing _meta.runtimeId → AMBIGUOUS_GLOBAL_STATE exit 35", () => {
  // status is otherwise ready (runtime.runtimeId present so D4 passes) but its
  // _meta block is absent. The consistency check requires status._meta.runtimeId
  // too, so a missing one classifies exactly like a task-list/gate-list miss and
  // names the status source.
  const status = readyStatus();
  delete status._meta;
  const fake = installFakeOrca({ status });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.blocking_reasons[0].reason_code, "AMBIGUOUS_GLOBAL_STATE");
    assert.match(body.blocking_reasons[0].message, /status/);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("Finding 6: status _meta.runtimeId disagrees with runtime.runtimeId → AMBIGUOUS_GLOBAL_STATE exit 35", () => {
  // status carries a _meta.runtimeId that differs from the D4-validated
  // runtime.runtimeId. All four observed ids must agree, so the disagreement
  // fails closed and the message names the status source.
  const status = readyStatus();
  status._meta.runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const fake = installFakeOrca({ status });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.blocking_reasons[0].reason_code, "AMBIGUOUS_GLOBAL_STATE");
    assert.match(body.blocking_reasons[0].message, /status/);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// Finding 1: contradictory list count vs array length → AMBIGUOUS_GLOBAL_STATE
// ---------------------------------------------------------------------------

test("Finding 1: task-list count contradicts array length → AMBIGUOUS_GLOBAL_STATE exit 35", () => {
  const fake = installFakeOrca({
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [{ id: "existing" }], count: 0 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.blocking_reasons[0].reason_code, "AMBIGUOUS_GLOBAL_STATE");
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("Finding 1: gate-list count contradicts array length → AMBIGUOUS_GLOBAL_STATE exit 35", () => {
  const fake = installFakeOrca({
    gateList: {
      id: "x",
      ok: true,
      result: { gates: [{ id: "g1" }, { id: "g2" }], count: 5 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.AMBIGUOUS_GLOBAL_STATE);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.blocking_reasons[0].reason_code, "AMBIGUOUS_GLOBAL_STATE");
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// Finding 2: a hung Orca subprocess must time out into the rejection matrix
// ---------------------------------------------------------------------------

test("Finding 2: hung status call times out → MALFORMED_OUTPUT exit 33, envelope emitted", () => {
  const fake = installFakeOrca();
  const started = Date.now();
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath], {
      RELAY_ORCA_PROBE_TIMEOUT_MS: "200",
      RELAY_FAKE_ORCA_STALL_MS: "5000",
      RELAY_FAKE_ORCA_STALL_CMD: "status",
    });
    assert.ok(Date.now() - started < 4000, "probe must not hang for the full stall duration");
    assert.equal(result.status, REASONS.MALFORMED_OUTPUT);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.blocking_reasons[0].reason_code, "MALFORMED_OUTPUT");
    assert.equal(body.runtime_ready, false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// Finding 2 (D8): subprocess-derived values embedded in messages stay bounded
// ---------------------------------------------------------------------------

test("Finding 2: oversized runtime.state is truncated in the RUNTIME_NOT_READY message", () => {
  const status = readyStatus();
  status.result.runtime.state = "x".repeat(10000); // shape-valid string, but not "ready"
  const fake = installFakeOrca({ status });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.RUNTIME_NOT_READY);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.runtime_ready, false);
    const reason = body.blocking_reasons[0];
    assert.equal(reason.reason_code, "RUNTIME_NOT_READY");
    // The embedded excerpt is bounded to <=256 chars TOTAL, marker included
    // (255 filler chars + the single `…` marker).
    const excerptMatch = reason.message.match(/x+…/);
    assert.ok(excerptMatch, "bounded excerpt with truncation marker must be present");
    assert.ok(
      excerptMatch[0].length <= 256,
      `embedded excerpt too long: ${excerptMatch[0].length}`,
    );
    // No 256-char run of the original filler survives the bound.
    assert.equal(reason.message.includes("x".repeat(256)), false);
    assert.ok(reason.message.includes("…"), "truncation marker must be present");
    // Whole message stays under a sane cap despite the 10k-char subprocess value.
    assert.ok(reason.message.length <= 512, `message too long: ${reason.message.length}`);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// D1/D8 all green
// ---------------------------------------------------------------------------

test("D1/D8: all green → admitted true, exact JSON keys, read-only invocation set", () => {
  const fake = installFakeOrca();
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, 0);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.ok, true);
    assert.equal(body.admitted, true);
    assert.equal(body.orca_bin, fake.orcaPath);
    assert.equal(body.orca_version, null);
    assert.equal(body.runtime_id, DEFAULT_RUNTIME_ID);
    assert.equal(body.runtime_ready, true);
    assert.equal(body.orchestration_available, true);
    assert.deepEqual(body.existing_state, { tasks: 0, gates: 0 });
    assert.deepEqual(body.blocking_reasons, []);
    assert.equal(body.smoke.requested, false);
    assert.equal(body.smoke.ran, false);
    assert.equal(body.smoke.cleaned_up, null);
    assertReadOnlyLog(fake.readLog());
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D1/D14: default mode never invokes smoke subcommands", () => {
  const fake = installFakeOrca();
  try {
    runProbe(["--json", "--orca-bin", fake.orcaPath]);
    const log = fake.readLog().join("\n");
    assert.equal(log.includes("task-create"), false);
    assert.equal(log.includes("dispatch"), false);
    assert.equal(log.includes("task-update"), false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// D9 smoke
// ---------------------------------------------------------------------------

test("D9: bare --smoke fails fast (exit 64) before creating smoke task state", () => {
  const fake = installFakeOrca();
  try {
    const result = runProbe(["--json", "--smoke", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /--smoke requires --smoke-to/);
    assert.equal(fake.readLog().length, 0, "no Orca commands may run before smoke-to is supplied");
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D9: --smoke-to without --smoke fails fast (exit 64)", () => {
  const result = runProbe(["--json", "--smoke-to", DEFAULT_LIVE_AGENT_HANDLE]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /--smoke-to requires --smoke/);
});

test("D9: smoke success — live target, provenance trio, failed cleanup status, no reset", () => {
  const fake = installFakeOrca();
  try {
    const result = runProbe(["--json", ...SMOKE_ARGS, "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, 0);
    const body = parseJson(result.stdout);
    assert.equal(body.admitted, true);
    assert.equal(body.smoke.requested, true);
    assert.equal(body.smoke.ran, true);
    assert.equal(body.smoke.cleaned_up, true);
    assert.equal(body.smoke.task_id, "smoke-task-1");
    assert.equal(body.smoke.dispatch_id, "smoke-dispatch-1");
    assert.equal(body.smoke.assignee, DEFAULT_LIVE_AGENT_HANDLE);

    const log = fake.readLog();
    const createLine = log.find((line) => line.includes("task-create"));
    assert.ok(createLine, "task-create must be recorded");
    assert.ok(createLine.includes(SMOKE_TITLE_MARKER), "task-title must contain smoke marker");
    assert.ok(
      log.some(
        (line) =>
          line.includes("dispatch") &&
          line.includes("--inject") &&
          line.includes(DEFAULT_LIVE_AGENT_HANDLE),
      ),
    );
    const updateLines = log.filter((line) => line.includes("task-update"));
    assert.equal(updateLines.length, 1);
    assert.ok(updateLines[0].includes("smoke-task-1"));
    assert.ok(updateLines[0].includes("--status failed"), "cleanup must use real CLI status failed");
    assert.equal(updateLines[0].includes("cancelled"), false);
    assert.equal(log.some((line) => line.includes("reset")), false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D9: smoke inject to non-agent / synthetic handle → SMOKE_FAILED, cleanup still attempted", () => {
  const fake = installFakeOrca({ liveAgentHandles: [] });
  try {
    const result = runProbe([
      "--json",
      "--smoke",
      "--smoke-to",
      "relay-orca-probe-smoke",
      "--orca-bin",
      fake.orcaPath,
    ]);
    assert.equal(result.status, REASONS.SMOKE_FAILED);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "SMOKE_FAILED");
    assert.match(body.blocking_reasons[0].message, /no recognized agent|dispatch --inject/);
    assert.equal(body.smoke.cleaned_up, true);
    const log = fake.readLog();
    assert.ok(log.some((line) => line.includes("task-update") && line.includes("--status failed")));
    assert.equal(log.some((line) => line.includes("reset")), false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D9: smoke provenance failure (null assignee) → SMOKE_FAILED exit 36, cleanup still attempted", () => {
  const fake = installFakeOrca({
    dispatch: {
      id: "dispatch-1",
      ok: true,
      result: {
        id: "smoke-dispatch-1",
        dispatch_id: "smoke-dispatch-1",
        assignee: null,
      },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", ...SMOKE_ARGS, "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.SMOKE_FAILED);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "SMOKE_FAILED");
    assert.equal(body.smoke.ran, true);
    assert.equal(body.smoke.cleaned_up, true);
    const log = fake.readLog();
    assert.ok(log.some((line) => line.includes("task-update") && line.includes("smoke-task-1")));
    assert.ok(log.some((line) => line.includes("--status failed")));
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D9: smoke cleanup failure → SMOKE_CLEANUP_FAILED exit 37, leftover id named, no reset", () => {
  const fake = installFakeOrca({
    taskUpdateExit: 1,
    taskUpdate: { ok: false, result: {} },
    taskUpdateStderr: "cannot update task",
  });
  try {
    const result = runProbe(["--json", ...SMOKE_ARGS, "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.SMOKE_CLEANUP_FAILED);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "SMOKE_CLEANUP_FAILED");
    assert.match(body.blocking_reasons[0].message, /smoke-task-1/);
    assert.equal(body.smoke.cleaned_up, false);
    assert.equal(fake.readLog().some((line) => line.includes("reset")), false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D9: smoke provenance AND cleanup both fail → both SMOKE_FAILED and SMOKE_CLEANUP_FAILED retained", () => {
  const fake = installFakeOrca({
    liveAgentHandles: [],
    taskUpdateExit: 1,
    taskUpdate: { ok: false, result: {} },
    taskUpdateStderr: "cannot update task",
  });
  try {
    const result = runProbe([
      "--json",
      "--smoke",
      "--smoke-to",
      "missing-agent",
      "--orca-bin",
      fake.orcaPath,
    ]);
    // Primary cause remains SMOKE_FAILED (not overwritten by cleanup).
    assert.equal(result.status, REASONS.SMOKE_FAILED);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.smoke.cleaned_up, false);
    const codes = body.blocking_reasons.map((r) => r.reason_code);
    assert.deepEqual(codes, ["SMOKE_FAILED", "SMOKE_CLEANUP_FAILED"]);
    assert.equal(fake.readLog().some((line) => line.includes("reset")), false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("D9: smoke task-create ok without a task id → SMOKE_FAILED exit 36, cleaned_up=false, no cleanup", () => {
  // task-create reports ok but returns no id: an untracked synthetic task may exist and
  // there is no id to clean, so cleaned_up must be false and no task-update may run.
  const fake = installFakeOrca({
    taskCreate: {
      id: "task-create-1",
      ok: true,
      result: {},
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", ...SMOKE_ARGS, "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.SMOKE_FAILED);
    const body = parseJson(result.stdout);
    assertExactKeys(body);
    assert.equal(body.admitted, false);
    assert.equal(body.blocking_reasons[0].reason_code, "SMOKE_FAILED");
    assert.equal(body.smoke.cleaned_up, false);
    // No id came back → no task-update cleanup may be attempted.
    assert.equal(
      fake.readLog().some((line) => line.includes("task-update")),
      false,
      "no task-update may run when no task id was returned",
    );
    // Remediation points the operator at the smoke title marker + task-list.
    assert.match(body.blocking_reasons[0].remediation, /relay-orca-probe-smoke/);
    assert.equal(fake.readLog().some((line) => line.includes("reset")), false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("Fixture: task-update rejects invalid status (cancelled) like the real CLI", () => {
  const fake = installFakeOrca();
  try {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(fake.orcaPath, ["orchestration", "task-update", "--id", "t1", "--status", "cancelled", "--json"], {
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (error) {
      status = error.status;
      stderr = error.stderr ? String(error.stderr) : "";
    }
    assert.notEqual(status, 0);
    assert.match(stderr, /Invalid --status|Valid --status/);
    assert.ok(VALID_TASK_STATUSES.includes("failed"));
    assert.equal(VALID_TASK_STATUSES.includes("cancelled"), false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("Fixture: dispatch --inject to missing agent handle is rejected like the real CLI", () => {
  const fake = installFakeOrca({ liveAgentHandles: ["only-real-agent"] });
  try {
    let status = 0;
    let stderr = "";
    let stdout = "";
    try {
      stdout = execFileSync(
        fake.orcaPath,
        ["orchestration", "dispatch", "--task", "t1", "--to", "synthetic", "--inject", "--json"],
        { encoding: "utf-8", stdio: "pipe" },
      );
    } catch (error) {
      status = error.status;
      stderr = error.stderr ? String(error.stderr) : "";
      stdout = error.stdout ? String(error.stdout) : "";
    }
    assert.notEqual(status, 0);
    assert.match(stderr, /no recognized agent detected/);
    const body = JSON.parse(stdout);
    assert.equal(body.ok, false);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

test("usage errors exit 64", () => {
  const result = runProbe(["--json", "--not-a-real-flag"]);
  assert.equal(result.status, 64);
});

test("blocking_reasons carry remediation; excerpts stay bounded", () => {
  const long = "x".repeat(500);
  const fake = installFakeOrca({
    taskListExit: 1,
    taskListStderr: long,
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    const body = parseJson(result.stdout);
    const reason = body.blocking_reasons[0];
    assert.equal(reason.reason_code, "ORCHESTRATION_UNAVAILABLE");
    assert.ok(typeof reason.remediation === "string" && reason.remediation.length > 0);
    assert.ok(reason.message.length <= 400);
    assertNoPoison(fake);
  } finally {
    fake.restore();
  }
});

// Keep helpers referenced so lint/coverage-style unused import checks stay quiet.
void readyStatus;
void emptyTaskList;
void emptyGateList;
