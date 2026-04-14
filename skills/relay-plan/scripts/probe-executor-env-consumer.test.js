const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  NO_QUALITY_INFRA_TEXT,
  readProbeSignals,
  renderProbeSignalSection,
} = require("./probe-executor-env-consumer");

const PROBE_SCRIPT = path.join(__dirname, "probe-executor-env.js");

function runProbeScript(repoRoot) {
  return spawnSync(process.execPath, [PROBE_SCRIPT, repoRoot, "--project-only", "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
}

test("consumer renders the no-signals state as an acceptable empty-quality card section", () => {
  // Failure-mode axis A: empty probe data is not an error fallback.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-no-signal-"));

  const result = runProbeScript(repoRoot);
  assert.equal(result.status, 0, result.stderr);

  const probe = JSON.parse(result.stdout);
  assert.deepEqual(probe.project_tools, {
    scripts: [],
    frameworks: [],
    ci: [],
  });

  const probeSignal = readProbeSignals(repoRoot);
  assert.equal(probeSignal.status, "available");
  assert.equal(probeSignal.empty_signal, true);

  const rendered = renderProbeSignalSection(probeSignal).join("\n");
  assert.match(rendered, /Probe signal: no quality infra detected\./);
  assert.match(rendered, new RegExp(`probe_signal\\.test_infra: ${NO_QUALITY_INFRA_TEXT}`));
  assert.match(rendered, new RegExp(`probe_signal\\.lint_format: ${NO_QUALITY_INFRA_TEXT}`));
  assert.match(rendered, new RegExp(`probe_signal\\.type_check: ${NO_QUALITY_INFRA_TEXT}`));
  assert.match(rendered, new RegExp(`probe_signal\\.ci: ${NO_QUALITY_INFRA_TEXT}`));
  assert.match(rendered, new RegExp(`probe_signal\\.scripts: ${NO_QUALITY_INFRA_TEXT}`));
  assert.doesNotMatch(rendered, /Probe signals unavailable:/);
});

test("consumer surfaces the agent probe error cause when a stub producer returns it", () => {
  // Failure-mode axis B: surfaced cause from producer output must stay visible.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-probe-error-"));
  const probeSignal = readProbeSignals(repoRoot, {
    command: process.execPath,
    args: [
      "-e",
      [
        "process.stdout.write(JSON.stringify({",
        "  executor: null,",
        `  repo: ${JSON.stringify(repoRoot)},`,
        "  agent_tools_raw: null,",
        "  agent_probe_error: 'probe timed out after 30s',",
        "  project_tools: { scripts: [], frameworks: [], ci: [] }",
        "}));",
      ].join("\n"),
    ],
  });

  assert.equal(probeSignal.status, "unavailable");
  assert.equal(probeSignal.cause, "probe timed out after 30s");

  const rendered = renderProbeSignalSection(probeSignal).join("\n");
  assert.match(
    rendered,
    /Probe signal: Probe signals unavailable: probe timed out after 30s\. Proceeding without probe signal\./
  );
});

test("consumer falls back cleanly on a generic non-zero command and does not block dispatch", () => {
  // Failure-mode axis C: non-zero producer exits must stay informational only.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-probe-failure-"));
  const probeSignal = readProbeSignals(repoRoot, {
    command: process.execPath,
    args: ["-e", "process.stderr.write('script missing\\n'); process.exit(7);"],
  });

  assert.equal(probeSignal.status, "unavailable");
  assert.equal(probeSignal.cause, "script missing");

  const rendered = renderProbeSignalSection(probeSignal).join("\n");
  assert.match(
    rendered,
    /Probe signal: Probe signals unavailable: script missing\. Proceeding without probe signal\./
  );
  assert.doesNotMatch(rendered, /dispatch blocked/i);
});
