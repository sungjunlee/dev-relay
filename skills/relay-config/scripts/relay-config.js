#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CORE_SCRIPT = path.resolve(__dirname, "..", "..", "relay-dispatch", "scripts", "relay-config.js");
const { loadProjectConfig } = require("../../relay-dispatch/scripts/project-config");
const VALID_PROFILES = new Set(["company", "personal"]);
const VALID_PHASES = new Set(["dispatch", "review", "advisory_review"]);
const REVIEWER_PHASES = new Set(["review", "advisory_review"]);

function hasFlag(args, flag) {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function relayHome() {
  return process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
}

function executorsConfigPath() {
  return process.env.RELAY_EXECUTORS_PATH || path.join(relayHome(), "executors.json");
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log("Usage: relay-config <command> [options]");
  console.log("");
  console.log("Interactive relay route-policy setup helper. Use the skill for natural-language setup, or this wrapper for deterministic shorthand.");
  console.log("");
  console.log("Common setup requests:");
  console.log('  "relay setup 해줘"');
  console.log('  "회사 환경으로 relay 설정해줘"');
  console.log('  "집에서는 example/opencode-model-fast를 advisory review에 쓰게 해줘"');
  console.log("");
  console.log("Commands:");
  console.log("  inspect [--json]");
  console.log("  init company|personal [--json]");
  console.log("  show [--json]");
  console.log("  doctor [--json]");
  console.log("  check <phase> <actor> [provider/model] [--json]");
  console.log("  allow-route <pattern> --phase <csv> [--executor <name>] [--reviewer <name>] [--json]");
  console.log("  deny-route <pattern> [--phase <csv>] [--executor <name>] [--reviewer <name>] [--json]");
  console.log("  set-default <path> <value> [--json]");
  console.log("");
  console.log("Policy boundary: executor/reviewer names are harnesses; provider/model route strings are the compliance boundary.");
}

function runCore(args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [CORE_SCRIPT, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf-8",
  });

  if (!capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    return {
      ok: false,
      error: `failed to parse ${label} JSON: ${error.message}`,
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  }
}

function inspect(jsonOut) {
  const showResult = runCore(["show", "--effective", "--json"], { capture: true });
  const doctorResult = runCore(["doctor", "--json"], { capture: true });
  const policy = parseJsonOutput(showResult, "show");
  const doctor = parseJsonOutput(doctorResult, "doctor");
  const configPath = executorsConfigPath();
  const projectConfig = loadProjectConfig({ repoRoot: process.cwd(), relayHome: relayHome() });
  const ok = showResult.status === 0 && doctorResult.status === 0;

  const output = {
    ok,
    policy,
    doctor,
    projectConfig,
    executorsConfig: {
      path: configPath,
      exists: fs.existsSync(configPath),
    },
  };

  if (jsonOut) {
    printJson(output);
    return ok ? 0 : 1;
  }

  console.log(`relay-config inspect: ${output.ok ? "ok" : "failed"}`);
  console.log(`policy status: ${policy.status || "unknown"}`);
  if (policy.sources?.global) console.log(`global policy: ${policy.sources.global}`);
  if (policy.sources?.repo) console.log(`repo policy: ${policy.sources.repo}`);
  console.log(`project config: ${projectConfig.status} at ${projectConfig.path || "(unresolved)"}`);
  console.log(`executors config: ${output.executorsConfig.exists ? "present" : "missing"} at ${configPath}`);
  if (Array.isArray(doctor.tools)) {
    for (const tool of doctor.tools) {
      const installed = tool.installed ? `installed at ${tool.path}` : "not installed on PATH";
      console.log(`${tool.name}: ${installed}; ${tool.policy} (${tool.reason})`);
    }
  }
  return ok ? 0 : 1;
}

function normalizeCheck(rest) {
  if (rest.length < 2 || rest[0].startsWith("-")) return ["check", ...rest];
  const [phase, actor, maybeModel, ...tail] = rest;
  if (!VALID_PHASES.has(phase)) return ["check", ...rest];

  const normalized = ["check", "--phase", phase, "--executor", actor];
  if (REVIEWER_PHASES.has(phase)) normalized.push("--reviewer", actor);

  if (maybeModel && !maybeModel.startsWith("-")) {
    normalized.push("--model", maybeModel);
    normalized.push(...tail);
  } else {
    if (maybeModel) normalized.push(maybeModel);
    normalized.push(...tail);
  }
  return normalized;
}

function normalizeArgs(args) {
  if (!args.length || hasFlag(args, "--help") || args.includes("-h")) return null;

  const [command, ...rest] = args;
  if (command === "inspect") {
    const unsupported = rest.filter((arg) => arg !== "--json");
    if (unsupported.length) {
      return {
        error: `unsupported arguments for inspect: ${[...new Set(unsupported)].join(", ")}`,
      };
    }
    return { inspect: true, jsonOut: hasFlag(rest, "--json") };
  }

  if (command === "init" && VALID_PROFILES.has(rest[0]) && !hasFlag(rest, "--profile")) {
    return { coreArgs: ["init", "--profile", rest[0], ...rest.slice(1)] };
  }

  if (command === "show" && !hasFlag(rest, "--effective")) {
    return { coreArgs: ["show", "--effective", ...rest] };
  }

  if (command === "check") {
    return { coreArgs: normalizeCheck(rest) };
  }

  return { coreArgs: args };
}

function main() {
  const normalized = normalizeArgs(process.argv.slice(2));
  if (normalized === null) {
    printHelp();
    return 0;
  }

  if (normalized.error) {
    console.error(`Error: ${normalized.error}`);
    return 1;
  }

  if (normalized.inspect) {
    return inspect(normalized.jsonOut);
  }

  const result = runCore(normalized.coreArgs);
  return result.status || 0;
}

process.exit(main());
