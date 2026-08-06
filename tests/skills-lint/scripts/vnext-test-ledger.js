"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LEDGER_DIR = path.join(REPO_ROOT, "tests", "ledger");
const DISPOSITIONS_PATH = path.join(LEDGER_DIR, "vnext-test-ledger.json");
const GENERATED_PATH = path.join(LEDGER_DIR, "vnext-test-sites.generated.json");
const BASELINE_PATH = path.join(LEDGER_DIR, "vnext-baseline.generated.json");
const MEASUREMENTS_PATH = path.join(LEDGER_DIR, "vnext-baseline-measurements.json");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "test.yml");

const MIN_MEASUREMENT_SAMPLES = 10;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function walkFiles(root, predicate = () => true) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, predicate));
    else if (entry.isFile() && predicate(absolute)) files.push(absolute);
  }
  return files.sort((left, right) => toPosix(left).localeCompare(toPosix(right)));
}

function discoverRelayTests(repoRoot = REPO_ROOT) {
  const testsRoot = path.join(repoRoot, "tests");
  if (!fs.existsSync(testsRoot)) return [];
  return fs.readdirSync(testsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^relay(?:-|$)/.test(entry.name))
    .flatMap((entry) => walkFiles(
      path.join(testsRoot, entry.name),
      (file) => file.endsWith(".test.js"),
    ))
    .map((file) => toPosix(path.relative(repoRoot, file)))
    .sort();
}

function normalizeName(value) {
  return value.replace(/\s+/g, " ").trim();
}

function parseQuoted(source, start, quote) {
  let value = "";
  let dynamic = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      value += source.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (character === quote) {
      return { name: normalizeName(value), dynamic, end: index + 1 };
    }
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      dynamic = true;
    }
    value += character;
  }
  throw new Error("unterminated test name literal");
}

function parseFirstArgument(source, start) {
  let index = start;
  while (/\s/.test(source[index] || "")) index += 1;
  if (source[index] === "'" || source[index] === "\"" || source[index] === "`") {
    return parseQuoted(source, index, source[index]);
  }

  let depth = 0;
  let value = "";
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") {
      if (depth === 0 && character === ")") break;
      depth -= 1;
    }
    if (character === "," && depth === 0) break;
    value += character;
  }
  return {
    name: `<dynamic:${normalizeName(value) || "expression"}>`,
    dynamic: true,
    end: index,
  };
}

function parseOptionsDirective(source, start) {
  let index = start;
  while (/\s/.test(source[index] || "")) index += 1;
  if (source[index] !== ",") return null;
  index += 1;
  while (/\s/.test(source[index] || "")) index += 1;
  if (source[index] !== "{") return null;

  const objectStart = index;
  let depth = 0;
  let quote = null;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const options = source.slice(objectStart, index + 1);
        const match = options.match(/\b(skip|only|todo)\s*:/);
        return match ? match[1] : null;
      }
    }
  }
  return null;
}

function discoverRegistrationSites(source, relativePath) {
  const registration = /^[ \t]*(?:await[ \t]+)?(test|it|describe|t\.test)(?:\.(skip|only|todo))?[ \t]*\(/gm;
  const sites = [];
  let match;
  while ((match = registration.exec(source)) !== null) {
    const openParen = match.index + match[0].lastIndexOf("(");
    const parsed = parseFirstArgument(source, openParen + 1);
    const ordinal = sites.length + 1;
    const line = source.slice(0, match.index).split("\n").length;
    const name = parsed.name || "<empty>";
    const directive = match[2] || parseOptionsDirective(source, parsed.end);
    sites.push({
      id: `${relativePath}::${match[1]}::${ordinal}`,
      path: relativePath,
      kind: match[1],
      name,
      ordinal,
      line,
      dynamic: parsed.dynamic,
      directive,
    });
  }
  return sites;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializeGeneratedLedger(generated) {
  const columns = [
    "path",
    "kind",
    "ordinal",
    "name",
    "line",
    "dynamic",
    "directive",
    "decision",
  ];
  const rows = generated.sites.map((site) => JSON.stringify(columns.map((column) => site[column])));
  return [
    "{",
    `  "schemaVersion": ${generated.schemaVersion},`,
    `  "accountingContract": ${JSON.stringify(generated.accountingContract)},`,
    `  "generatedBy": ${JSON.stringify(generated.generatedBy)},`,
    `  "files": ${generated.files},`,
    `  "registrationSites": ${generated.registrationSites},`,
    `  "dynamicRegistrationSites": ${generated.dynamicRegistrationSites},`,
    `  "columns": ${JSON.stringify(columns)},`,
    '  "rows": [',
    rows.map((row, index) => `    ${row}${index === rows.length - 1 ? "" : ","}`).join("\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
}

function validateDisposition(entry) {
  const allowed = ["path", "owner", "rationale"];
  for (const field of allowed) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`${entry.path || "<unknown>"}: missing non-empty ${field}`);
    }
  }
  for (const field of Object.keys(entry)) {
    if (!allowed.includes(field)) {
      throw new Error(`${entry.path}: unexpected disposition field ${field}`);
    }
  }
}

function validateDispositions(ledger, repoRoot = REPO_ROOT) {
  if (ledger.schemaVersion !== 1) throw new Error("ledger schemaVersion must be 1");
  if (ledger.accountingContract !== "lexical-registration-site-v1") {
    throw new Error("ledger accountingContract must be lexical-registration-site-v1");
  }
  if (!Array.isArray(ledger.files)) throw new Error("ledger files must be an array");
  if (!Array.isArray(ledger.approvedDirectives)) {
    throw new Error("ledger approvedDirectives must be an array");
  }

  const paths = ledger.files.map((entry) => entry.path);
  const duplicates = paths.filter((value, index) => paths.indexOf(value) !== index);
  if (duplicates.length > 0) throw new Error(`duplicate ledger files: ${[...new Set(duplicates)].join(", ")}`);
  for (const entry of ledger.files) validateDisposition(entry);

  const discovered = discoverRelayTests(repoRoot);
  const missing = discovered.filter((file) => !paths.includes(file));
  const stale = paths.filter((file) => !discovered.includes(file));
  if (missing.length || stale.length) {
    throw new Error([
      "relay test ledger diverged from the filesystem",
      `missing: ${missing.join(", ") || "(none)"}`,
      `stale: ${stale.join(", ") || "(none)"}`,
    ].join("\n"));
  }
  if (paths.join("\n") !== [...paths].sort().join("\n")) {
    throw new Error("ledger files must be sorted by path");
  }
}

function buildGeneratedLedger(ledger, repoRoot = REPO_ROOT) {
  validateDispositions(ledger, repoRoot);
  const dispositionByPath = new Map(ledger.files.map((entry) => [entry.path, entry]));
  const sites = [];
  for (const relativePath of discoverRelayTests(repoRoot)) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    const disposition = dispositionByPath.get(relativePath);
    for (const site of discoverRegistrationSites(source, relativePath)) {
      sites.push({
        ...site,
        decision: { owner: disposition.owner, rationale: disposition.rationale },
      });
    }
  }

  const ids = sites.map((site) => site.id);
  const duplicates = ids.filter((value, index) => ids.indexOf(value) !== index);
  if (duplicates.length) throw new Error(`duplicate registration identities: ${duplicates.join(", ")}`);

  const directives = sites.filter((site) => site.directive);
  const approvals = new Map(ledger.approvedDirectives.map((approval) => [approval.id, approval]));
  const duplicateApprovals = ledger.approvedDirectives
    .map((approval) => approval.id)
    .filter((value, index, values) => values.indexOf(value) !== index);
  if (duplicateApprovals.length) throw new Error(`duplicate directive approvals: ${duplicateApprovals.join(", ")}`);

  const unapproved = directives.filter((site) => !approvals.has(site.id));
  const staleApprovals = ledger.approvedDirectives.filter((approval) => !directives.some((site) => site.id === approval.id));
  if (unapproved.length || staleApprovals.length) {
    throw new Error([
      "test directives require exact, non-stale approvals",
      `unapproved: ${unapproved.map((site) => `${site.id} (${site.directive})`).join(", ") || "(none)"}`,
      `stale approvals: ${staleApprovals.map((approval) => approval.id).join(", ") || "(none)"}`,
    ].join("\n"));
  }
  for (const approval of ledger.approvedDirectives) {
    for (const field of ["id", "owner", "reason", "expires"]) {
      if (typeof approval[field] !== "string" || approval[field].trim() === "") {
        throw new Error(`directive approval requires ${field}`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(approval.expires)) {
      throw new Error(`${approval.id}: expires must be YYYY-MM-DD`);
    }
    const today = new Date().toISOString().slice(0, 10);
    if (approval.expires < today) throw new Error(`${approval.id}: directive approval expired ${approval.expires}`);
  }

  return {
    schemaVersion: 1,
    accountingContract: ledger.accountingContract,
    generatedBy: "node tests/skills-lint/scripts/vnext-test-ledger.js generate",
    files: ledger.files.length,
    registrationSites: sites.length,
    dynamicRegistrationSites: sites.filter((site) => site.dynamic).length,
    sites,
  };
}

function countLines(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  return (source.match(/\n/g) || []).length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function measureRuntime(repoRoot = REPO_ROOT, samples = MIN_MEASUREMENT_SAMPLES, runner = spawnSync) {
  if (!Number.isInteger(samples) || samples < MIN_MEASUREMENT_SAMPLES) {
    throw new Error(`measurement samples must be an integer >= ${MIN_MEASUREMENT_SAMPLES}`);
  }
  const scenarios = [
    {
      name: "dispatch",
      testPath: "tests/relay-dispatch/scripts/runtime-contract-blackbox.test.js",
      testName: "RR-01 worktree containment",
    },
    {
      name: "recovery",
      testPath: "tests/relay-dispatch/scripts/runtime-contract-blackbox.test.js",
      testName: "RR-10 crash-safe idempotent recovery publication",
    },
  ];
  const results = {};
  for (const scenario of scenarios) {
    const observations = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const started = process.hrtime.bigint();
      const result = runner(process.execPath, [
        "--test",
        "--test-concurrency=1",
        `--test-name-pattern=${scenario.testName}`,
        scenario.testPath,
      ], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 120_000,
      });
      const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      observations.push({
        durationMs,
        exitCode: Number.isInteger(result.status) ? result.status : 1,
      });
    }
    const observedFailures = observations.filter((entry) => entry.exitCode !== 0).length;
    results[scenario.name] = {
      command: `node --test --test-concurrency=1 --test-name-pattern=${JSON.stringify(scenario.testName)} ${scenario.testPath}`,
      durationsMs: observations.map((entry) => entry.durationMs),
      medianMs: median(observations.map((entry) => entry.durationMs)),
      observedFailures,
      observedFailureRate: observedFailures / samples,
    };
  }
  const commandRuns = scenarios.length * samples;
  const observedFailures = Object.values(results).reduce((sum, result) => sum + result.observedFailures, 0);
  return {
    schemaVersion: 1,
    baselineKind: "focused-e2e-flake-baseline",
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    samplesPerScenario: samples,
    scenarios: results,
    focusedE2EFlakeObservation: {
      commandRuns,
      observedFailures,
      observedFailureRate: observedFailures / commandRuns,
      scope: "Repeat-based E2E observation of RR-01 dispatch containment and RR-10 idempotent recovery publication only.",
    },
  };
}

function validateMeasurements(measurements) {
  if (!measurements || measurements.schemaVersion !== 1) throw new Error("baseline measurements schemaVersion must be 1");
  if (measurements.baselineKind !== "focused-e2e-flake-baseline") {
    throw new Error("baseline measurements require focused-e2e-flake-baseline kind");
  }
  if (!Number.isInteger(measurements.samplesPerScenario)
      || measurements.samplesPerScenario < MIN_MEASUREMENT_SAMPLES) {
    throw new Error(`baseline measurements require samplesPerScenario >= ${MIN_MEASUREMENT_SAMPLES}`);
  }
  for (const name of ["dispatch", "recovery"]) {
    const scenario = measurements.scenarios?.[name];
    if (!scenario || !Array.isArray(scenario.durationsMs) || scenario.durationsMs.length !== measurements.samplesPerScenario) {
      throw new Error(`baseline measurements require ${name} durations`);
    }
    if (scenario.durationsMs.some((duration) => !Number.isInteger(duration) || duration < 0)) {
      throw new Error(`baseline measurements contain invalid ${name} duration`);
    }
    if (!Number.isInteger(scenario.observedFailures)) throw new Error(`${name} observedFailures is required`);
    if (scenario.observedFailureRate !== scenario.observedFailures / measurements.samplesPerScenario) {
      throw new Error(`${name} observedFailureRate is inconsistent`);
    }
  }
  const observation = measurements.focusedE2EFlakeObservation;
  const expectedRuns = measurements.samplesPerScenario * 2;
  const expectedFailures = measurements.scenarios.dispatch.observedFailures
    + measurements.scenarios.recovery.observedFailures;
  if (observation?.commandRuns !== expectedRuns
      || observation?.observedFailures !== expectedFailures
      || observation?.observedFailureRate !== expectedFailures / expectedRuns) {
    throw new Error("baseline measurements require consistent focused E2E flake observations");
  }
  if (!measurements.scenarios.dispatch.command.includes("runtime-contract-blackbox.test.js")
      || !measurements.scenarios.dispatch.command.includes("RR-01 worktree containment")
      || !measurements.scenarios.recovery.command.includes("runtime-contract-blackbox.test.js")
      || !measurements.scenarios.recovery.command.includes("RR-10 crash-safe idempotent recovery publication")) {
    throw new Error("baseline measurements must use the RR-01 and RR-10 E2E black-box scenarios");
  }
  return measurements;
}

function readMeasurements(repoRoot = REPO_ROOT) {
  const measurementPath = path.join(repoRoot, "tests", "ledger", "vnext-baseline-measurements.json");
  if (!fs.existsSync(measurementPath)) {
    return {
      status: "pending-focused-e2e-measurement",
      refreshCommand: `node tests/skills-lint/scripts/vnext-test-ledger.js measure --samples=${MIN_MEASUREMENT_SAMPLES}`,
    };
  }
  return validateMeasurements(readJson(measurementPath));
}

function buildBaseline(repoRoot = REPO_ROOT) {
  const runtimeRoot = path.join(repoRoot, "skills", "relay-dispatch", "scripts");
  const runtimeFiles = walkFiles(runtimeRoot, (file) => file.endsWith(".js"));
  const testFiles = discoverRelayTests(repoRoot).map((file) => path.join(repoRoot, file));
  const ledger = readJson(path.join(repoRoot, "tests", "ledger", "vnext-test-ledger.json"));
  const generated = buildGeneratedLedger(ledger, repoRoot);
  return {
    schemaVersion: 1,
    generatedBy: "node tests/skills-lint/scripts/vnext-test-ledger.js generate",
    staticMetrics: {
      relayDispatchRuntimeJavaScriptFiles: runtimeFiles.length,
      relayDispatchRuntimeJavaScriptLoc: runtimeFiles.reduce((sum, file) => sum + countLines(file), 0),
      relayTestFiles: testFiles.length,
      relayTestLoc: testFiles.reduce((sum, file) => sum + countLines(file), 0),
      relayRegistrationSites: generated.registrationSites,
      dynamicRegistrationSites: generated.dynamicRegistrationSites,
    },
    measuredRuntime: readMeasurements(repoRoot),
    measurementPlan: {
      kind: "focused-e2e-flake-baseline",
      minimumSamplesPerScenario: MIN_MEASUREMENT_SAMPLES,
      refreshCommand: `node tests/skills-lint/scripts/vnext-test-ledger.js measure --samples=${MIN_MEASUREMENT_SAMPLES} && node tests/skills-lint/scripts/vnext-test-ledger.js generate`,
      scope: "20 command runs: 10 RR-01 dispatch containment E2E runs and 10 RR-10 idempotent recovery publication E2E runs.",
      executionPolicy: "Generation reads checked-in observations but never executes benchmark commands.",
    },
  };
}

function assertGeneratedFile(filePath, expected) {
  if (!fs.existsSync(filePath)) throw new Error(`generated file is missing: ${toPosix(path.relative(REPO_ROOT, filePath))}`);
  const actual = fs.readFileSync(filePath, "utf8");
  if (actual !== expected) {
    throw new Error(`${toPosix(path.relative(REPO_ROOT, filePath))} is stale; run vnext-test-ledger.js generate`);
  }
}

function check(repoRoot = REPO_ROOT) {
  const ledgerPath = path.join(repoRoot, "tests", "ledger", "vnext-test-ledger.json");
  const ledger = readJson(ledgerPath);
  const generatedLedger = buildGeneratedLedger(ledger, repoRoot);
  const generated = serializeGeneratedLedger(generatedLedger);
  const baseline = stableJson(buildBaseline(repoRoot));
  assertGeneratedFile(path.join(repoRoot, "tests", "ledger", "vnext-test-sites.generated.json"), generated);
  assertGeneratedFile(path.join(repoRoot, "tests", "ledger", "vnext-baseline.generated.json"), baseline);
  return { ledger, generated: generatedLedger, baseline: JSON.parse(baseline) };
}

function generate(repoRoot = REPO_ROOT) {
  const ledgerPath = path.join(repoRoot, "tests", "ledger", "vnext-test-ledger.json");
  const ledger = readJson(ledgerPath);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "tests", "ledger", "vnext-test-sites.generated.json"),
    serializeGeneratedLedger(buildGeneratedLedger(ledger, repoRoot)),
  );
  fs.writeFileSync(
    path.join(repoRoot, "tests", "ledger", "vnext-baseline.generated.json"),
    stableJson(buildBaseline(repoRoot)),
  );
}

function writeMeasurements(repoRoot = REPO_ROOT, samples = MIN_MEASUREMENT_SAMPLES) {
  const measurements = measureRuntime(repoRoot, samples);
  fs.writeFileSync(
    path.join(repoRoot, "tests", "ledger", "vnext-baseline-measurements.json"),
    stableJson(measurements),
  );
  return measurements;
}

if (require.main === module) {
  const command = process.argv[2] || "check";
  if (command === "generate") generate();
  else if (command === "check") check();
  else if (command === "baseline") process.stdout.write(stableJson(buildBaseline()));
  else if (command === "measure") {
    const sampleArgument = process.argv.find((argument) => argument.startsWith("--samples="));
    const samples = sampleArgument ? Number(sampleArgument.split("=")[1]) : MIN_MEASUREMENT_SAMPLES;
    process.stdout.write(stableJson(writeMeasurements(REPO_ROOT, samples)));
  }
  else {
    process.stderr.write(`unknown command: ${command}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  MIN_MEASUREMENT_SAMPLES,
  buildBaseline,
  buildGeneratedLedger,
  check,
  discoverRegistrationSites,
  discoverRelayTests,
  generate,
  measureRuntime,
  readMeasurements,
  serializeGeneratedLedger,
  stableJson,
  validateDispositions,
  validateMeasurements,
  writeMeasurements,
};
