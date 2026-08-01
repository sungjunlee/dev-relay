#!/usr/bin/env node
/**
 * Probe the executor environment to discover available tools/skills.
 * Informs rubric design by revealing which evaluated factors can become automated.
 *
 * Usage:
 *   ./probe-executor-env.js <repo-path> --executor <name> [options]
 *
 * Options:
 *   --executor, -e <name>  Executor to probe (required)
 *   --model, -m <route>    Explicit provider/model selection recorded in output
 *   --timeout <seconds>    Probe timeout (default: 30)
 *   --project-only         Skip agent probe, only scan project tools
 *   --json                 Output as JSON (default: human-readable)
 */

const fs = require("fs");
const path = require("path");
const {
  bindCliArgs,
  findUnknownFlags,
  getPositionals,
  modeLabel: formatCliModeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const { getExecutor, listExecutors } = require("../../relay-dispatch/scripts/executors");

// ---------------------------------------------------------------------------
// CLI (only when run directly)
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const args = argv.slice(2);
  const KNOWN_FLAGS = [
    "--executor", "-e", "--model", "-m", "--timeout", "--project-only", "--json", "--help", "-h",
  ];
  const CLI_ARG_OPTIONS = {
    reservedFlags: KNOWN_FLAGS,
    booleanFlags: ["--project-only", "--json", "--help", "-h"],
    verbatimValueFlags: [],
  };
  const unknownFlags = findUnknownFlags(args, CLI_ARG_OPTIONS);
  if (unknownFlags.length) throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  const cliArgs = bindCliArgs(args, CLI_ARG_OPTIONS);
  if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
    console.log(`Usage: probe-executor-env.js <repo-path> --executor <${listExecutors().join("|")}> [options]`);
    console.log("\nOptions:");
    console.log(`  --executor, -e   ${formatCliModeLabel("--executor", CLI_ARG_OPTIONS)} Executor to probe (${listExecutors().join(", ")})`);
    console.log(`  --model, -m      ${formatCliModeLabel("--model", CLI_ARG_OPTIONS)} Explicit provider/model selection`);
    console.log(`  --timeout        ${formatCliModeLabel("--timeout", CLI_ARG_OPTIONS)} Probe timeout in seconds (default: 30)`);
    console.log(`  --project-only   ${formatCliModeLabel("--project-only", CLI_ARG_OPTIONS)} Skip agent probe, only scan project tools`);
    console.log(`  --json           ${formatCliModeLabel("--json", CLI_ARG_OPTIONS)} Output as JSON`);
    process.exit(0);
  }

  const repoPathRaw = getPositionals(args, CLI_ARG_OPTIONS)[0];

  return {
    repoPath: path.resolve(repoPathRaw || "."),
    executor: cliArgs.getArg(["--executor", "-e"], undefined),
    model: cliArgs.getArg(["--model", "-m"], undefined),
    timeout: parseInt(cliArgs.getArg("--timeout", "30"), 10),
    projectOnly: cliArgs.hasFlag("--project-only"),
    jsonOut: cliArgs.hasFlag("--json"),
  };
}

// ---------------------------------------------------------------------------
// Project tool scanning (no agent invocation)
// ---------------------------------------------------------------------------

function scanPackageJson(repoPath) {
  const pkgPath = path.join(repoPath, "package.json");
  if (!fs.existsSync(pkgPath)) return { scripts: [], devDeps: [] };

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const scripts = Object.keys(pkg.scripts || {}).map((name) => ({
      name: `npm run ${name}`,
      command: pkg.scripts[name],
      source: "package.json",
    }));

    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    const TOOL_PACKAGES = [
      "jest", "vitest", "mocha", "playwright", "@playwright/test",
      "cypress", "eslint", "prettier", "typescript",
      "webpack", "vite", "esbuild", "rollup",
      "lighthouse", "axe-core", "@axe-core/cli", "pa11y",
      "bundlesize", "size-limit",
      "gitleaks",
    ];
    const devDeps = TOOL_PACKAGES
      .filter((name) => name in allDeps)
      .map((name) => ({ name, version: allDeps[name], source: "package.json" }));

    return { scripts, devDeps };
  } catch {
    return { scripts: [], devDeps: [] };
  }
}

function scanMakefile(repoPath) {
  const makefilePath = path.join(repoPath, "Makefile");
  if (!fs.existsSync(makefilePath)) return [];

  try {
    const content = fs.readFileSync(makefilePath, "utf-8");
    return content.split("\n")
      .filter((line) => /^[a-zA-Z_][\w-]*\s*:/.test(line) && !line.startsWith("\t"))
      .map((line) => ({
        name: `make ${line.split(":")[0].trim()}`,
        source: "Makefile",
      }));
  } catch {
    return [];
  }
}

function scanPyproject(repoPath) {
  const pyprojectPath = path.join(repoPath, "pyproject.toml");
  if (!fs.existsSync(pyprojectPath)) return [];

  try {
    const content = fs.readFileSync(pyprojectPath, "utf-8");
    const tools = [];

    if (/\[tool\.pytest/.test(content)) tools.push({ name: "pytest", source: "pyproject.toml" });
    if (/\[tool\.mypy/.test(content)) tools.push({ name: "mypy", source: "pyproject.toml" });
    if (/\[tool\.ruff/.test(content)) tools.push({ name: "ruff", source: "pyproject.toml" });
    if (/\[tool\.black/.test(content)) tools.push({ name: "black", source: "pyproject.toml" });
    if (/\[tool\.isort/.test(content)) tools.push({ name: "isort", source: "pyproject.toml" });
    if (/\[tool\.pylint/.test(content)) tools.push({ name: "pylint", source: "pyproject.toml" });
    if (/\[tool\.coverage/.test(content)) tools.push({ name: "coverage", source: "pyproject.toml" });

    return tools;
  } catch {
    return [];
  }
}

function scanCiWorkflows(repoPath) {
  const workflowsDir = path.join(repoPath, ".github", "workflows");
  if (!fs.existsSync(workflowsDir)) return [];

  try {
    return fs.readdirSync(workflowsDir)
      .filter((name) => /\.ya?ml$/i.test(name))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ name, source: ".github/workflows" }));
  } catch {
    return [];
  }
}

function scanProjectTools(repoPath) {
  const pkg = scanPackageJson(repoPath);
  const makeTargets = scanMakefile(repoPath);
  const pyTools = scanPyproject(repoPath);
  const ci = scanCiWorkflows(repoPath);

  return {
    scripts: [...pkg.scripts, ...makeTargets],
    frameworks: [...pkg.devDeps, ...pyTools],
    ci,
  };
}

function deriveTestInfra(projectTools) {
  const known = new Set(["jest", "vitest", "mocha", "playwright", "@playwright/test", "pytest"]);
  const frameworks = Array.isArray(projectTools?.frameworks) ? projectTools.frameworks : [];
  const scripts = Array.isArray(projectTools?.scripts) ? projectTools.scripts : [];
  const infra = [];
  for (const framework of frameworks) {
    if (known.has(framework.name)) {
      infra.push({ name: framework.name, source: framework.source });
    }
  }
  for (const script of scripts) {
    if (/\b(node --test|jest|vitest|mocha|pytest|playwright test)\b/.test(script.command || script.name || "")) {
      infra.push({ name: script.name, command: script.command || null, source: script.source });
    }
  }
  return infra;
}

// ---------------------------------------------------------------------------
// Agent probe
// ---------------------------------------------------------------------------

function probeAgent(executor, timeout) {
  let adapter;
  try {
    adapter = getExecutor(executor);
  } catch {
    return { error: `unknown executor: ${executor}`, raw: null };
  }
  return adapter.probe({ timeout });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run({ repoPath, executor, model, timeout, projectOnly, jsonOut }) {
  const projectTools = scanProjectTools(repoPath);

  let agentProbe = { error: null, raw: null };
  if (!projectOnly) {
    agentProbe = probeAgent(executor, timeout);
  }

  const result = {
    executor: executor || null,
    model: typeof model === "string" && model.trim() ? model.trim() : null,
    repo: repoPath,
    agent_tools_raw: agentProbe.raw,
    agent_probe_error: agentProbe.error || null,
    test_infra: deriveTestInfra(projectTools),
    project_tools: projectTools,
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Executor environment probe: ${executor || "(project-only)"}`);
    console.log(`Repo: ${repoPath}\n`);

    if (agentProbe.error) {
      console.log(`Agent probe: ${agentProbe.error}`);
    } else if (agentProbe.raw) {
      console.log(`Agent tools:\n${agentProbe.raw}`);
    } else if (!projectOnly) {
      console.log("Agent tools: none discovered");
    }

    if (projectTools.frameworks.length > 0) {
      console.log(`\nProject frameworks:`);
      projectTools.frameworks.forEach((t) => console.log(`  ${t.name} (${t.source})`));
    }

    if (projectTools.scripts.length > 0) {
      console.log(`\nProject scripts:`);
      projectTools.scripts.forEach((t) => console.log(`  ${t.name} (${t.source})`));
    }

    if (projectTools.ci.length > 0) {
      console.log(`\nCI workflows:`);
      projectTools.ci.forEach((t) => console.log(`  ${t.name} (${t.source})`));
    }
  }
}

if (require.main === module) {
  const opts = parseCli(process.argv);
  if (!opts.projectOnly && !opts.executor) {
    console.error("Error: --executor is required (or use --project-only)");
    process.exit(1);
  }
  if (isNaN(opts.timeout) || opts.timeout <= 0) {
    console.error("Error: --timeout must be a positive integer");
    process.exit(1);
  }
  run(opts);
}

module.exports = { deriveTestInfra, scanProjectTools, probeAgent, run };
