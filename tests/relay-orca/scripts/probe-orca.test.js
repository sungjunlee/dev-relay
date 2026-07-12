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
} = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));

const READ_ONLY_SUBCOMMANDS = new Set(["status", "task-list", "gate-list"]);
const FORBIDDEN_DEFAULT = ["task-create", "task-update", "dispatch", "run", "reset"];

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

test("D6: tasks count > 0 → EXISTING_ORCHESTRATION_STATE exit 34", () => {
  const fake = installFakeOrca({
    taskList: {
      id: "x",
      ok: true,
      result: { tasks: [{ id: "pre" }], count: 1 },
      _meta: { runtimeId: DEFAULT_RUNTIME_ID },
    },
  });
  try {
    const result = runProbe(["--json", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.EXISTING_ORCHESTRATION_STATE);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "EXISTING_ORCHESTRATION_STATE");
    assert.match(body.blocking_reasons[0].message, /tasks=1/);
    assert.match(body.blocking_reasons[0].message, /gates=0/);
    assert.equal(body.admitted, false);
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

test("D9: smoke success — marker, provenance trio, self-only cleanup", () => {
  const fake = installFakeOrca();
  try {
    const result = runProbe(["--json", "--smoke", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, 0);
    const body = parseJson(result.stdout);
    assert.equal(body.admitted, true);
    assert.equal(body.smoke.requested, true);
    assert.equal(body.smoke.ran, true);
    assert.equal(body.smoke.cleaned_up, true);
    assert.equal(body.smoke.task_id, "smoke-task-1");
    assert.equal(body.smoke.dispatch_id, "smoke-dispatch-1");
    assert.equal(body.smoke.assignee, "relay-orca-probe-smoke");

    const log = fake.readLog();
    const createLine = log.find((line) => line.includes("task-create"));
    assert.ok(createLine, "task-create must be recorded");
    assert.ok(createLine.includes(SMOKE_TITLE_MARKER), "task-title must contain smoke marker");
    assert.ok(log.some((line) => line.includes("dispatch") && line.includes("--inject")));
    const updateLines = log.filter((line) => line.includes("task-update"));
    assert.equal(updateLines.length, 1);
    assert.ok(updateLines[0].includes("smoke-task-1"));
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
    const result = runProbe(["--json", "--smoke", "--orca-bin", fake.orcaPath]);
    assert.equal(result.status, REASONS.SMOKE_FAILED);
    const body = parseJson(result.stdout);
    assert.equal(body.blocking_reasons[0].reason_code, "SMOKE_FAILED");
    assert.equal(body.smoke.ran, true);
    assert.equal(body.smoke.cleaned_up, true);
    const log = fake.readLog();
    assert.ok(log.some((line) => line.includes("task-update") && line.includes("smoke-task-1")));
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
    const result = runProbe(["--json", "--smoke", "--orca-bin", fake.orcaPath]);
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

test("Finding 3: smoke task-create ok without a task id → SMOKE_FAILED exit 36, cleaned_up=false, no cleanup", () => {
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
    const result = runProbe(["--json", "--smoke", "--orca-bin", fake.orcaPath]);
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
