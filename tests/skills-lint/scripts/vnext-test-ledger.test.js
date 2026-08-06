"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildBaseline,
  buildGeneratedLedger,
  check,
  discoverRegistrationSites,
  discoverRelayTests,
  measureRuntime,
  serializeGeneratedLedger,
  validateMeasurements,
  validateDispositions,
} = require("./vnext-test-ledger");

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function fixtureRepo(source = 'test("keeps invariant", () => {});\n') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-ledger-"));
  const relativePath = "tests/relay-dispatch/scripts/example.test.js";
  write(path.join(repoRoot, relativePath), source);
  write(path.join(repoRoot, "skills/relay-dispatch/scripts/example.js"), '"use strict";\n');
  const ledger = {
    schemaVersion: 1,
    accountingContract: "lexical-registration-site-v1",
    approvedDirectives: [],
    files: [{
      path: relativePath,
      owner: "runtime-core-reset",
      rationale: "A durable behavior.",
    }],
  };
  write(
    path.join(repoRoot, "tests/ledger/vnext-test-ledger.json"),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
  return { repoRoot, relativePath, ledger };
}

test("registration discovery gives static and dynamic sites stable path/name/ordinal identities", () => {
  const source = [
    'test("static case", () => {});',
    "for (const item of cases) {",
    "  test(`${item} dynamic case`, () => {});",
    "}",
    'describe("group", () => {',
    '  it("nested", () => {});',
    "});",
    'assert.match(text, /test("not a registration")/);',
    "",
  ].join("\n");
  const sites = discoverRegistrationSites(source, "tests/relay/scripts/example.test.js");
  assert.deepEqual(
    sites.map(({ id, name, ordinal, dynamic }) => ({ id, name, ordinal, dynamic })),
    [
      {
        id: "tests/relay/scripts/example.test.js::test::1",
        name: "static case",
        ordinal: 1,
        dynamic: false,
      },
      {
        id: "tests/relay/scripts/example.test.js::test::2",
        name: "${item} dynamic case",
        ordinal: 2,
        dynamic: true,
      },
      {
        id: "tests/relay/scripts/example.test.js::describe::3",
        name: "group",
        ordinal: 3,
        dynamic: false,
      },
      {
        id: "tests/relay/scripts/example.test.js::it::4",
        name: "nested",
        ordinal: 4,
        dynamic: false,
      },
    ],
  );
});

test("ledger fails closed on missing, stale, duplicate, and schema-invalid file decisions", () => {
  const { repoRoot, relativePath, ledger } = fixtureRepo();
  try {
    assert.deepEqual(discoverRelayTests(repoRoot), [relativePath]);

    assert.throws(
      () => validateDispositions({ ...ledger, files: [] }, repoRoot),
      /missing: tests\/relay-dispatch\/scripts\/example\.test\.js/,
    );
    assert.throws(
      () => validateDispositions({
        ...ledger,
        files: [...ledger.files, ledger.files[0]],
      }, repoRoot),
      /duplicate ledger files/,
    );
    assert.throws(
      () => validateDispositions({
        ...ledger,
        files: [{ ...ledger.files[0], path: "tests/relay/scripts/stale.test.js" }],
      }, repoRoot),
      /stale: tests\/relay\/scripts\/stale\.test\.js/,
    );
    const withoutRationale = { ...ledger.files[0] };
    delete withoutRationale.rationale;
    assert.throws(
      () => validateDispositions({ ...ledger, files: [withoutRationale] }, repoRoot),
      /missing non-empty rationale/,
    );
    assert.throws(
      () => validateDispositions({
        ...ledger,
        files: [{ ...ledger.files[0], rationale: "   " }],
      }, repoRoot),
      /missing non-empty rationale/,
    );
    assert.throws(
      () => validateDispositions({
        ...ledger,
        files: [{ ...ledger.files[0], classification: "preserve-invariant" }],
      }, repoRoot),
      /unexpected disposition field classification/,
    );
    assert.throws(
      () => validateDispositions({
        ...ledger,
        files: [{ ...ledger.files[0], invariantIds: ["RR-01"] }],
      }, repoRoot),
      /unexpected disposition field invariantIds/,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("skip, only, and todo registrations require exact non-stale approvals", () => {
  const { repoRoot, ledger } = fixtureRepo('test.only("focused", () => {});\n');
  try {
    assert.throws(
      () => buildGeneratedLedger(ledger, repoRoot),
      /unapproved: .*test::1 \(only\)/,
    );
    ledger.approvedDirectives.push({
      id: "tests/relay-dispatch/scripts/example.test.js::test::1",
      owner: "runtime-core-reset",
      reason: "Temporary external dependency.",
      expires: "2099-01-01",
    });
    assert.equal(buildGeneratedLedger(ledger, repoRoot).registrationSites, 1);
    ledger.approvedDirectives[0].expires = "2000-01-01";
    assert.throws(() => buildGeneratedLedger(ledger, repoRoot), /directive approval expired/);
    ledger.approvedDirectives[0].expires = "2099-01-01";
    ledger.approvedDirectives[0].id = "tests/relay-dispatch/scripts/example.test.js::test::2";
    assert.throws(() => buildGeneratedLedger(ledger, repoRoot), /stale approvals/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("generated site output and static baseline are byte deterministic", () => {
  const { repoRoot, ledger } = fixtureRepo();
  try {
    const first = serializeGeneratedLedger(buildGeneratedLedger(ledger, repoRoot));
    const second = serializeGeneratedLedger(buildGeneratedLedger(ledger, repoRoot));
    assert.equal(first, second);
    assert.deepEqual(JSON.parse(first).columns, [
      "path",
      "kind",
      "ordinal",
      "name",
      "line",
      "dynamic",
      "directive",
      "decision",
    ]);

    const baseline = buildBaseline(repoRoot);
    assert.equal(baseline.staticMetrics.relayDispatchRuntimeJavaScriptFiles, 1);
    assert.equal(baseline.staticMetrics.relayTestFiles, 1);
    assert.equal(baseline.measuredRuntime.status, "pending-focused-e2e-measurement");
    assert.match(baseline.measurementPlan.executionPolicy, /never executes benchmark commands/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runtime measurement mode records dispatch/recovery latency and failure observations", () => {
  let calls = 0;
  const measurements = measureRuntime(process.cwd(), 10, (_command, args, options) => {
    calls += 1;
    assert.equal(args[0], "--test");
    assert.equal(args.at(-1), "tests/relay-dispatch/scripts/runtime-contract-blackbox.test.js");
    assert.equal(options.timeout, 120_000);
    return { status: calls === 20 ? 1 : 0 };
  });
  assert.equal(calls, 20);
  assert.equal(measurements.baselineKind, "focused-e2e-flake-baseline");
  assert.equal(measurements.samplesPerScenario, 10);
  assert.equal(measurements.scenarios.dispatch.durationsMs.length, 10);
  assert.equal(measurements.scenarios.recovery.durationsMs.length, 10);
  assert.match(measurements.scenarios.dispatch.command, /RR-01 worktree containment/);
  assert.match(measurements.scenarios.recovery.command, /RR-10 crash-safe idempotent recovery publication/);
  assert.equal(measurements.scenarios.dispatch.observedFailureRate, 0);
  assert.equal(measurements.scenarios.recovery.observedFailureRate, 0.1);
  assert.equal(measurements.focusedE2EFlakeObservation.commandRuns, 20);
  assert.equal(measurements.focusedE2EFlakeObservation.observedFailures, 1);
  assert.equal(measurements.focusedE2EFlakeObservation.observedFailureRate, 0.05);
  assert.equal(validateMeasurements(measurements), measurements);
  assert.throws(
    () => measureRuntime(process.cwd(), 9, () => ({ status: 0 })),
    /integer >= 10/,
  );
});

test("the site table still catches a dropped or fabricated relay test file", () => {
  const { repoRoot, relativePath, ledger } = fixtureRepo();
  const secondPath = "tests/relay-dispatch/scripts/second.test.js";
  try {
    write(path.join(repoRoot, secondPath), 'test("second invariant", () => {});\n');
    const entries = [
      ledger.files[0],
      { path: secondPath, owner: "runtime-core-reset", rationale: "Another durable behavior." },
    ];
    const complete = buildGeneratedLedger({ ...ledger, files: entries }, repoRoot);
    assert.equal(complete.files, 2);
    assert.deepEqual(complete.sites.map((site) => site.path), [relativePath, secondPath]);

    assert.throws(
      () => buildGeneratedLedger({ ...ledger, files: [entries[0]] }, repoRoot),
      new RegExp(`missing: ${secondPath.replace(/[.]/g, "\\.")}`),
    );
    assert.throws(
      () => buildGeneratedLedger({ ...ledger, files: [entries[1]] }, repoRoot),
      new RegExp(`missing: ${relativePath.replace(/[.]/g, "\\.")}`),
    );

    const ghost = {
      path: "tests/relay-dispatch/scripts/never-written.test.js",
      owner: "runtime-core-reset",
      rationale: "Nothing on disk.",
    };
    assert.throws(
      () => buildGeneratedLedger({ ...ledger, files: [entries[0], ghost, entries[1]] }, repoRoot),
      new RegExp(`stale: ${ghost.path.replace(/[.]/g, "\\.")}`),
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("checked-in ledger and generated artifacts exactly cover the current relay tests", () => {
  const result = check();
  assert.equal(result.generated.files, result.ledger.files.length);
  assert.ok(result.generated.registrationSites > result.generated.files);
  assert.equal(
    result.generated.sites.filter((site) => site.directive).length,
    result.ledger.approvedDirectives.length,
  );
  const dispatchVnext = result.generated.sites.filter(
    (site) => site.path === "tests/relay-dispatch/scripts/dispatch-vnext.test.js",
  );
  assert.ok(dispatchVnext.length > 0, "vNext dispatch must retain executable black-box coverage");

  assert.ok(result.generated.sites.length > 0);
  for (const site of result.generated.sites) {
    assert.deepEqual(Object.keys(site.decision).sort(), ["owner", "rationale"]);
    assert.equal(typeof site.decision.owner, "string");
    assert.equal(typeof site.decision.rationale, "string");
    assert.ok(site.decision.owner.trim() !== "");
    assert.ok(site.decision.rationale.trim() !== "");
  }
});
