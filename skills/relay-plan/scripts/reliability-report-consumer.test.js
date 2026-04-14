const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { createRunId, ensureRunLayout } = require("../../relay-dispatch/scripts/relay-manifest");
const {
  NO_HISTORY_TEXT,
  readHistoricalSignal,
  renderHistoricalSignalSection,
} = require("./reliability-report-consumer");

const REPORT_SCRIPT = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "reliability-report.js");

function withRelayHome(relayHome, callback) {
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;
  try {
    return callback();
  } finally {
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }
}

function runReliabilityReport(repoRoot, relayHome) {
  return spawnSync(process.execPath, [REPORT_SCRIPT, "--repo", repoRoot, "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
    },
  });
}

test("consumer treats no prior runs as empty history instead of a fallback error", () => {
  // Failure-mode axis A: empty history must stay on the no-history path.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-empty-history-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-home-"));

  const result = runReliabilityReport(repoRoot, relayHome);
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.totals.manifests, 0);
  assert.equal(report.totals.events, 0);
  assert.deepEqual(report.factor_analysis, {
    factors: {},
    most_stuck_factor: null,
  });

  const historicalSignal = withRelayHome(relayHome, () => readHistoricalSignal(repoRoot));
  assert.equal(historicalSignal.status, "available");
  assert.equal(historicalSignal.empty_history, true);

  const rendered = renderHistoricalSignalSection(historicalSignal).join("\n");
  assert.match(rendered, /Empty-data state — historical signal not available, proceed to rubric design\./);
  assert.match(rendered, new RegExp(NO_HISTORY_TEXT));
  assert.doesNotMatch(rendered, /Reliability report unavailable:/);
});

test("consumer surfaces the producer stderr cause when stored relay data is malformed", () => {
  // Failure-mode axis B: malformed stored data must downgrade to a named fallback.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-bad-history-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-home-"));
  const runId = createRunId({
    branch: "bad-history",
    timestamp: new Date("2026-04-14T00:00:00.000Z"),
  });
  const { manifestPath } = withRelayHome(relayHome, () => ensureRunLayout(repoRoot, runId));
  fs.writeFileSync(manifestPath, "---\nbroken\n---\n", "utf-8");

  const result = runReliabilityReport(repoRoot, relayHome);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Error: Invalid manifest entry on line 2/);

  const historicalSignal = withRelayHome(relayHome, () => readHistoricalSignal(repoRoot));
  assert.equal(historicalSignal.status, "unavailable");
  assert.equal(historicalSignal.cause, "Invalid manifest entry on line 2");

  const rendered = renderHistoricalSignalSection(historicalSignal).join("\n");
  assert.match(
    rendered,
    /Reliability report unavailable: Invalid manifest entry on line 2\. Proceeding without historical signal\./
  );
  assert.match(rendered, new RegExp(`historical_signal\\.stuck_factors: ${NO_HISTORY_TEXT}`));
});

test("consumer falls back cleanly on a generic non-zero command and still proceeds without historical signal", () => {
  // Failure-mode axis C: non-zero producer exits must not stop planning.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-generic-failure-"));
  const historicalSignal = readHistoricalSignal(repoRoot, {
    command: process.execPath,
    args: ["-e", "process.stderr.write('fake producer failure\\n'); process.exit(7);"],
  });

  assert.equal(historicalSignal.status, "unavailable");
  assert.equal(historicalSignal.cause, "fake producer failure");

  const rendered = renderHistoricalSignalSection(historicalSignal).join("\n");
  assert.match(
    rendered,
    /Reliability report unavailable: fake producer failure\. Proceeding without historical signal\./
  );
  assert.doesNotMatch(rendered, /dispatch blocked/i);
});
