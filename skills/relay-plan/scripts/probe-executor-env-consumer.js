const { execFileSync } = require("child_process");
const path = require("path");

const NO_QUALITY_INFRA_TEXT = "no quality infra detected";

const TEST_RUNNERS = new Set([
  "jest",
  "vitest",
  "mocha",
  "playwright",
  "@playwright/test",
  "cypress",
  "pytest",
]);

const LINT_FORMAT_TOOLS = new Set([
  "eslint",
  "prettier",
  "ruff",
  "black",
  "isort",
  "pylint",
]);

const TYPE_CHECK_TOOLS = new Set([
  "typescript",
  "mypy",
]);

function buildDefaultCommand(repoRoot) {
  return {
    command: process.execPath,
    args: [
      path.join(__dirname, "probe-executor-env.js"),
      repoRoot,
      "--project-only",
      "--json",
    ],
  };
}

function formatFailureCause(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) {
    const [firstLine] = stderr.split("\n");
    if (firstLine) {
      return firstLine.replace(/^Error:\s*/, "").trim();
    }
  }

  if (typeof error?.status === "number") {
    return `exit code ${error.status}`;
  }

  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  return "unknown failure";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function listOrFallback(values) {
  return values.length > 0 ? values.join(", ") : NO_QUALITY_INFRA_TEXT;
}

function normalizeFrameworkNames(frameworks) {
  if (!Array.isArray(frameworks)) return [];
  return frameworks
    .map((entry) => (typeof entry?.name === "string" ? entry.name : null))
    .filter(Boolean);
}

function normalizeScripts(scripts) {
  if (!Array.isArray(scripts)) return [];
  return scripts.filter((entry) => entry && typeof entry === "object");
}

function extractTypeCheckSignals(projectTools) {
  const frameworks = normalizeFrameworkNames(projectTools?.frameworks)
    .filter((name) => TYPE_CHECK_TOOLS.has(name));
  const scripts = normalizeScripts(projectTools?.scripts)
    .map((script) => {
      const command = typeof script.command === "string" ? script.command : "";
      const name = typeof script.name === "string" ? script.name : "";
      if (/tsc\s+--noEmit/.test(command)) return "tsc --noEmit";
      if (/\bmypy\b/.test(command)) return command.trim();
      if (/\bmypy\b/.test(name)) return name.trim();
      return null;
    })
    .filter(Boolean);

  return listOrFallback(unique([...frameworks, ...scripts]));
}

function extractCiSignals(projectTools) {
  const ciWorkflows = Array.isArray(projectTools?.ci)
    ? projectTools.ci
      .map((entry) => (typeof entry?.name === "string" ? entry.name : null))
      .filter(Boolean)
    : [];
  if (ciWorkflows.length === 0) {
    return NO_QUALITY_INFRA_TEXT;
  }

  return `GitHub Actions (${ciWorkflows.join(", ")})`;
}

function extractScriptSignals(projectTools) {
  const scripts = normalizeScripts(projectTools?.scripts)
    .map((script) => (typeof script.name === "string" ? script.name : null))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 5);

  return listOrFallback(scripts);
}

function extractProbeSignals(projectTools) {
  const frameworkNames = normalizeFrameworkNames(projectTools?.frameworks);

  return {
    test_infra: listOrFallback(unique(frameworkNames.filter((name) => TEST_RUNNERS.has(name)))),
    lint_format: listOrFallback(unique(frameworkNames.filter((name) => LINT_FORMAT_TOOLS.has(name)))),
    type_check: extractTypeCheckSignals(projectTools),
    ci: extractCiSignals(projectTools),
    scripts: extractScriptSignals(projectTools),
  };
}

function renderProbeSignalSection(result) {
  const lines = [];
  if (result.status === "unavailable") {
    lines.push(`Probe signal: Probe signals unavailable: ${result.cause}. Proceeding without probe signal.`);
  } else if (result.empty_signal) {
    lines.push(`Probe signal: ${NO_QUALITY_INFRA_TEXT}.`);
  } else {
    lines.push("Probe signal:");
  }

  lines.push(`probe_signal.test_infra: ${result.probe_signal.test_infra}`);
  lines.push(`probe_signal.lint_format: ${result.probe_signal.lint_format}`);
  lines.push(`probe_signal.type_check: ${result.probe_signal.type_check}`);
  lines.push(`probe_signal.ci: ${result.probe_signal.ci}`);
  lines.push(`probe_signal.scripts: ${result.probe_signal.scripts}`);
  return lines;
}

function readProbeSignals(repoRoot, command = buildDefaultCommand(repoRoot)) {
  try {
    const stdout = execFileSync(command.command, command.args, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const probe = JSON.parse(stdout);

    if (typeof probe?.agent_probe_error === "string" && probe.agent_probe_error.trim()) {
      return {
        status: "unavailable",
        cause: probe.agent_probe_error.trim(),
        probe_signal: extractProbeSignals({}),
      };
    }

    const probeSignal = extractProbeSignals(probe?.project_tools);
    const emptySignal = Object.values(probeSignal).every((value) => value === NO_QUALITY_INFRA_TEXT);

    return {
      status: "available",
      empty_signal: emptySignal,
      probe,
      probe_signal: probeSignal,
    };
  } catch (error) {
    return {
      status: "unavailable",
      cause: formatFailureCause(error),
      probe_signal: extractProbeSignals({}),
    };
  }
}

module.exports = {
  NO_QUALITY_INFRA_TEXT,
  buildDefaultCommand,
  readProbeSignals,
  renderProbeSignalSection,
};
