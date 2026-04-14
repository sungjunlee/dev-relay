#!/usr/bin/env node
/**
 * Probe the executor environment to discover available tools/skills.
 * Informs rubric design by revealing which evaluated factors can become automated.
 *
 * Usage:
 *   ./probe-executor-env.js <repo-path> --executor <codex|claude> [options]
 *
 * Options:
 *   --executor, -e <name>  Executor to probe (required)
 *   --timeout <seconds>    Probe timeout (default: 30)
 *   --project-only         Skip agent probe, only scan project tools
 *   --json                 Output as JSON (default: human-readable)
 */

const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// CLI (only when run directly)
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const args = argv.slice(2);
  const KNOWN_FLAGS = [
    "--executor", "-e", "--timeout", "--project-only", "--json", "--help", "-h",
  ];

  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: probe-executor-env.js <repo-path> --executor <codex|claude> [options]");
    console.log("\nOptions:");
    console.log("  --executor, -e   Executor to probe (codex, claude)");
    console.log("  --timeout        Probe timeout in seconds (default: 30)");
    console.log("  --project-only   Skip agent probe, only scan project tools");
    console.log("  --json           Output as JSON");
    process.exit(0);
  }

  function getArg(flags, fallback) {
    for (const flag of Array.isArray(flags) ? flags : [flags]) {
      const idx = args.indexOf(flag);
      if (idx !== -1 && idx + 1 < args.length && !KNOWN_FLAGS.includes(args[idx + 1])) {
        return args[idx + 1];
      }
    }
    return fallback;
  }
  const hasFlag = (f) => args.includes(f);

  const consumedIndices = new Set();
  for (let i = 0; i < args.length; i++) {
    if (KNOWN_FLAGS.includes(args[i]) && !["--project-only", "--json", "--help", "-h"].includes(args[i])) {
      consumedIndices.add(i);
      consumedIndices.add(i + 1);
      i++;
    } else if (["--project-only", "--json", "--help", "-h"].includes(args[i])) {
      consumedIndices.add(i);
    }
  }
  const repoPathRaw = args.find((a, i) => !consumedIndices.has(i) && !a.startsWith("-"));

  return {
    repoPath: path.resolve(repoPathRaw || "."),
    executor: getArg(["--executor", "-e"], undefined),
    timeout: parseInt(getArg("--timeout", "30"), 10),
    projectOnly: hasFlag("--project-only"),
    jsonOut: hasFlag("--json"),
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

// ---------------------------------------------------------------------------
// Agent probe
// ---------------------------------------------------------------------------

const PROBE_PROMPT =
  "List ALL your available tools, MCP servers, and installed skills. " +
  "Output a JSON array of objects with {name, type, description} fields. " +
  "type is one of: skill, mcp_tool, built_in.";

function probeAgent(executor, timeout) {
  let cmd, cmdArgs;

  if (executor === "codex") {
    cmd = "codex";
    cmdArgs = ["exec", "--full-auto", "--sandbox", "read-only", "--color", "never", PROBE_PROMPT];
  } else if (executor === "claude") {
    cmd = "claude";
    cmdArgs = ["-p", "--output-format", "text", PROBE_PROMPT];
  } else {
    return { error: `unknown executor: ${executor}`, raw: null };
  }

  // Check executor is available
  try {
    execFileSync(cmd, ["--version"], { encoding: "utf-8", stdio: "pipe" });
  } catch {
    return { error: `${cmd} CLI not found`, raw: null };
  }

  const result = spawnSync(cmd, cmdArgs, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: timeout * 1000,
  });

  if (result.error) {
    const msg = result.error.code === "ETIMEDOUT"
      ? `probe timed out after ${timeout}s`
      : result.error.message;
    return { error: msg, raw: null };
  }

  if (result.status !== 0) {
    return { error: `executor exited with code ${result.status}`, raw: null };
  }

  const stdout = (result.stdout || "").trim();
  return { error: null, raw: stdout || null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run({ repoPath, executor, timeout, projectOnly, jsonOut }) {
  const projectTools = scanProjectTools(repoPath);

  let agentProbe = { error: null, raw: null };
  if (!projectOnly) {
    agentProbe = probeAgent(executor, timeout);
  }

  const result = {
    executor: executor || null,
    repo: repoPath,
    agent_tools_raw: agentProbe.raw,
    agent_probe_error: agentProbe.error || null,
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

module.exports = { scanProjectTools, probeAgent, run };
