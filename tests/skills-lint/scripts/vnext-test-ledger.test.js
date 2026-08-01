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
      classification: "preserve-invariant",
      rationale: "A durable behavior.",
      invariantIds: ["RR-10"],
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
    const invalid = { ...ledger.files[0] };
    delete invalid.invariantIds;
    assert.throws(
      () => validateDispositions({ ...ledger, files: [invalid] }, repoRoot),
      /preserve-invariant requires invariantIds/,
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

test("site rules classify mixed files per registration and emit complete site decisions", () => {
  const source = [
    'test("worktree containment remains enforced", () => {});',
    'test("legacy route flag remains readable during migration", () => {});',
    'test("parse helper formats output", () => {});',
    'test("ordinary legacy transition", () => {});',
    "",
  ].join("\n");
  const { repoRoot, ledger } = fixtureRepo(source);
  try {
    ledger.files[0].classification = "compatibility-migration";
    ledger.files[0].rationale = "Default migration behavior.";
    delete ledger.files[0].invariantIds;
    ledger.files[0].migrationTarget = "vNext action fold";
    ledger.files[0].removalGate = "Shadow parity.";
    ledger.files[0].siteRules = [
      {
        match: { ordinals: [1], names: ["worktree containment remains enforced"] },
        decision: {
          owner: "runtime-core-reset",
          classification: "preserve-invariant",
          rationale: "Canonical containment.",
          invariantIds: ["RR-01"],
        },
      },
      {
        match: { ordinals: [2] },
        decision: {
          owner: "runtime-core-reset",
          classification: "obsolete-surface-delete",
          rationale: "Routing is removed.",
          surface: "legacy routing",
          removalIssue: "#1134",
        },
      },
      {
        match: { ordinals: [3] },
        decision: {
          owner: "runtime-core-reset",
          classification: "implementation-detail-delete",
          rationale: "Formatting helper.",
          replacementCoverage: "Public command contract.",
        },
      },
    ];
    const generated = buildGeneratedLedger(ledger, repoRoot);
    assert.deepEqual(
      generated.sites.map((site) => site.decision.classification),
      [
        "preserve-invariant",
        "obsolete-surface-delete",
        "implementation-detail-delete",
        "compatibility-migration",
      ],
    );
    assert.deepEqual(generated.sites[0].decision.invariantIds, ["RR-01"]);
    assert.equal(generated.sites[1].decision.removalIssue, "#1134");
    assert.equal(generated.sites[2].decision.replacementCoverage, "Public command contract.");
    assert.equal(generated.sites[3].decision.migrationTarget, "vNext action fold");
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
  assert.ok(dispatchVnext.every((site) => site.decision.classification === "preserve-invariant"));

  const preserved = result.generated.sites.filter(
    (site) => site.decision.classification === "preserve-invariant",
  );
  assert.ok(preserved.length > 0);
  for (const site of preserved) {
    assert.ok(site.decision.invariantIds.every((id) => /^RR-(0[1-9]|1[0-2])$/.test(id)));
  }
});
