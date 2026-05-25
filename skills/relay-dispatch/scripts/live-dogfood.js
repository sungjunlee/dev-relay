#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const OUTCOMES = Object.freeze({
  PASS: "pass",
  FAIL_SAFE_PASS: "fail-safe-pass",
  TIMEOUT: "timeout",
  FAIL: "fail",
  NOT_RUN: "not-run",
});

const DEFAULTS = Object.freeze({
  piModel: "opencode-go/deepseek-v4-pro",
  opencodeModel: "opencode-go/deepseek-v4-pro",
  antigravityModel: "google/antigravity-cli",
  commandTimeoutMs: 60_000,
  piReviewTimeout: "30s",
  antigravityReviewTimeout: "5s",
  antigravityDispatchTimeoutSeconds: 45,
});

function parseArgs(argv) {
  const parsed = {
    repo: ".",
    relayHome: null,
    keepRelayHome: false,
    probeOnly: false,
    dryRun: false,
    json: false,
    markdown: false,
    piModel: DEFAULTS.piModel,
    opencodeModel: DEFAULTS.opencodeModel,
    antigravityModel: DEFAULTS.antigravityModel,
    commandTimeoutMs: DEFAULTS.commandTimeoutMs,
    piReviewTimeout: DEFAULTS.piReviewTimeout,
    antigravityReviewTimeout: DEFAULTS.antigravityReviewTimeout,
    antigravityDispatchTimeoutSeconds: DEFAULTS.antigravityDispatchTimeoutSeconds,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--repo") parsed.repo = next();
    else if (arg === "--relay-home") parsed.relayHome = next();
    else if (arg === "--keep-relay-home") parsed.keepRelayHome = true;
    else if (arg === "--probe-only") parsed.probeOnly = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--markdown") parsed.markdown = true;
    else if (arg === "--pi-model") parsed.piModel = next();
    else if (arg === "--opencode-model") parsed.opencodeModel = next();
    else if (arg === "--antigravity-model") parsed.antigravityModel = next();
    else if (arg === "--command-timeout-ms") parsed.commandTimeoutMs = Number(next());
    else if (arg === "--pi-review-timeout") parsed.piReviewTimeout = next();
    else if (arg === "--antigravity-review-timeout") parsed.antigravityReviewTimeout = next();
    else if (arg === "--antigravity-dispatch-timeout") parsed.antigravityDispatchTimeoutSeconds = Number(next());
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!Number.isSafeInteger(parsed.commandTimeoutMs) || parsed.commandTimeoutMs <= 0) {
    throw new Error("--command-timeout-ms must be a positive integer");
  }
  if (!Number.isSafeInteger(parsed.antigravityDispatchTimeoutSeconds) || parsed.antigravityDispatchTimeoutSeconds <= 0) {
    throw new Error("--antigravity-dispatch-timeout must be a positive integer");
  }
  return parsed;
}

function mergeRouteEntry(entries, { route, phases, executors = [], reviewers = [] }) {
  const existing = entries.get(route) || { route, phases: [], executors: [], reviewers: [] };
  for (const phase of phases) if (!existing.phases.includes(phase)) existing.phases.push(phase);
  for (const executor of executors) if (!existing.executors.includes(executor)) existing.executors.push(executor);
  for (const reviewer of reviewers) if (!existing.reviewers.includes(reviewer)) existing.reviewers.push(reviewer);
  entries.set(route, existing);
}

function buildAllowedModelRoutes(options = {}) {
  const routes = new Map();
  const piModel = options.piModel || DEFAULTS.piModel;
  const opencodeModel = options.opencodeModel || DEFAULTS.opencodeModel;
  const antigravityModel = options.antigravityModel || DEFAULTS.antigravityModel;

  mergeRouteEntry(routes, {
    route: piModel,
    phases: ["dispatch", "review"],
    executors: ["pi"],
    reviewers: ["pi"],
  });
  mergeRouteEntry(routes, {
    route: opencodeModel,
    phases: ["dispatch", "advisory_review"],
    executors: ["opencode"],
    reviewers: ["opencode"],
  });
  mergeRouteEntry(routes, {
    route: antigravityModel,
    phases: ["dispatch", "review"],
    executors: ["antigravity"],
    reviewers: ["antigravity"],
  });
  return Array.from(routes.values());
}

function buildPolicy(options = {}) {
  return {
    version: 1,
    profile: "live-adapter-dogfood",
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
      sidecar: null,
    },
    managed_cli: ["codex", "claude"],
    allowed_model_routes: buildAllowedModelRoutes(options),
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  };
}

function ensureRelayHome(relayHome, options = {}) {
  const resolved = relayHome
    ? path.resolve(relayHome)
    : fs.mkdtempSync(path.join(os.tmpdir(), "relay-live-dogfood-"));
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "policy.json"), `${JSON.stringify(buildPolicy(options), null, 2)}\n`, "utf-8");
  return resolved;
}

function writePromptFiles(relayHome) {
  const promptDir = path.join(relayHome, "dogfood-prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  const advisoryPrompt = path.join(promptDir, "advisory-prompt.md");
  const primaryPrompt = path.join(promptDir, "primary-prompt.md");
  const rubric = path.join(promptDir, "antigravity-dispatch-rubric.yaml");
  fs.writeFileSync(advisoryPrompt, [
    "Return exactly one advisory JSON object for a relay live dogfood canary.",
    "The object must contain profile, summary, required_findings, advisory_findings, and duplicate_or_low_confidence.",
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(primaryPrompt, [
    "Return exactly one relay primary review verdict JSON object.",
    "Use verdict=pass, contract_status=pass, quality_review_status=pass, next_action=ready_to_merge, no issues, and empty scope drift.",
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(rubric, [
    "factors:",
    "  - name: live_dogfood_noop",
    "    target: 3",
    "    criteria:",
    "      3: Live dogfood canary returns a safe no-op classification.",
    "      0: Live dogfood canary incorrectly creates reviewable output.",
    "",
  ].join("\n"), "utf-8");
  return { advisoryPrompt, primaryPrompt, rubric };
}

function plannedStep(name, command, notes = "") {
  return { name, outcome: OUTCOMES.NOT_RUN, command, notes };
}

function spawnCommand({ spawnImpl, cwd, env, command, args, timeoutMs }) {
  return spawnImpl(command, args, {
    cwd,
    env,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
}

function summarizeOutput(result) {
  const stderr = String(result.stderr || "").trim();
  const stdout = String(result.stdout || "").trim();
  const error = result.error?.message ? String(result.error.message).trim() : "";
  return (stderr || stdout || error).split(/\r?\n/).slice(0, 8).join("\n");
}

function classifyStandardJson(result) {
  if (result.error?.code === "ETIMEDOUT") return { outcome: OUTCOMES.TIMEOUT, notes: "harness command timeout" };
  const parsed = parseJson(result.stdout);
  if (result.status === 0 && parsed) return { outcome: OUTCOMES.PASS, parsed, notes: "valid JSON returned" };
  const text = summarizeOutput(result);
  if (/timed out/i.test(text)) return { outcome: OUTCOMES.TIMEOUT, notes: text };
  return { outcome: OUTCOMES.FAIL, notes: text || "command failed without parseable JSON" };
}

function classifyProbeJson(result) {
  const standard = classifyStandardJson(result);
  if (standard.outcome !== OUTCOMES.PASS) return standard;
  const parsed = standard.parsed;
  if (parsed.agent_probe_error) {
    return { outcome: OUTCOMES.FAIL, parsed, notes: `agent_probe_error: ${parsed.agent_probe_error}` };
  }
  if (parsed.policy_decision?.allowed !== true) {
    return { outcome: OUTCOMES.FAIL, parsed, notes: `policy denied route: ${parsed.policy_decision?.reason || "unknown"}` };
  }
  if (!String(parsed.agent_tools_raw || "").trim()) {
    return { outcome: OUTCOMES.FAIL, parsed, notes: "probe returned no agent_tools_raw evidence" };
  }
  return standard;
}

function classifyAntigravityPrimary(result) {
  const standard = classifyStandardJson(result);
  if (standard.outcome === OUTCOMES.TIMEOUT && /Antigravity reviewer primary_review timed out/i.test(standard.notes)) {
    return { ...standard, outcome: OUTCOMES.FAIL_SAFE_PASS };
  }
  return standard;
}

function classifyAntigravityDispatch(result) {
  if (result.error?.code === "ETIMEDOUT") return { outcome: OUTCOMES.TIMEOUT, notes: "harness command timeout" };
  const parsed = parseJson(result.stdout);
  if (!parsed) return { outcome: OUTCOMES.FAIL, notes: summarizeOutput(result) || "dispatch did not return JSON" };
  if (result.status === 0 && parsed.runState === "review_pending" && parsed.prNumber) {
    return { outcome: OUTCOMES.PASS, parsed, notes: "dispatch produced reviewable PR" };
  }
  if (parsed.runState === "escalated" && parsed.status === "failed" && parsed.prNumber === null) {
    return { outcome: OUTCOMES.FAIL_SAFE_PASS, parsed, notes: parsed.error || "dispatch failed safely without PR" };
  }
  return { outcome: OUTCOMES.FAIL, parsed, notes: parsed.error || `unexpected dispatch state ${parsed.runState || "(unknown)"}` };
}

function buildSteps({ repo, relayHome, prompts, options }) {
  const node = process.execPath;
  const dispatchBranch = `dogfood-antigravity-${Date.now()}`;
  return [
    {
      name: "probe-pi",
      command: [node, "skills/relay-plan/scripts/probe-executor-env.js", repo, "--executor", "pi", "--model", options.piModel, "--json"],
      classify: classifyProbeJson,
    },
    {
      name: "probe-opencode",
      command: [node, "skills/relay-plan/scripts/probe-executor-env.js", repo, "--executor", "opencode", "--model", options.opencodeModel, "--json"],
      classify: classifyProbeJson,
    },
    {
      name: "probe-antigravity",
      command: [node, "skills/relay-plan/scripts/probe-executor-env.js", repo, "--executor", "antigravity", "--model", options.antigravityModel, "--json"],
      classify: classifyProbeJson,
    },
    {
      name: "opencode-advisory",
      command: [node, "skills/relay-review/scripts/invoke-reviewer-opencode.js", "--repo", repo, "--prompt-file", prompts.advisoryPrompt, "--model", options.opencodeModel, "--json"],
      classify: classifyStandardJson,
    },
    {
      name: "pi-primary",
      command: [node, "skills/relay-review/scripts/invoke-reviewer-pi.js", "--repo", repo, "--prompt-file", prompts.primaryPrompt, "--model", options.piModel, "--json"],
      env: { RELAY_PI_REVIEW_TIMEOUT: options.piReviewTimeout },
      classify: classifyStandardJson,
    },
    {
      name: "antigravity-primary-timeout",
      command: [node, "skills/relay-review/scripts/invoke-reviewer-antigravity.js", "--repo", repo, "--prompt-file", prompts.primaryPrompt, "--model", options.antigravityModel, "--json"],
      env: { RELAY_ANTIGRAVITY_REVIEW_TIMEOUT: options.antigravityReviewTimeout },
      classify: classifyAntigravityPrimary,
    },
    {
      name: "antigravity-dispatch",
      command: [
        node,
        "skills/relay-dispatch/scripts/dispatch.js",
        repo,
        "-b", dispatchBranch,
        "--prompt", "Live dogfood canary: do not modify repository files unless explicitly testing minimal dispatch output.",
        "--executor", "antigravity",
        "--model", options.antigravityModel,
        "--rubric-file", prompts.rubric,
        "--timeout", String(options.antigravityDispatchTimeoutSeconds),
        "--json",
      ],
      classify: classifyAntigravityDispatch,
    },
  ].filter((step) => !options.probeOnly || step.name.startsWith("probe-"))
    .map((step) => ({ ...step, relayHome }));
}

function runDogfood(options = {}, deps = {}) {
  const spawnImpl = deps.spawnSync || spawnSync;
  const repo = path.resolve(options.repo || ".");
  const effectiveOptions = { ...DEFAULTS, ...options };
  const relayHome = ensureRelayHome(options.relayHome, effectiveOptions);
  const prompts = writePromptFiles(relayHome);
  const envBase = { ...process.env, RELAY_HOME: relayHome };
  const steps = buildSteps({ repo, relayHome, prompts, options: effectiveOptions });

  const results = steps.map((step) => {
    const commandText = step.command.map((part) => String(part)).join(" ");
    if (options.dryRun) return plannedStep(step.name, commandText, "dry-run");
    const [command, ...args] = step.command;
    const raw = spawnCommand({
      spawnImpl,
      cwd: repo,
      env: { ...envBase, ...(step.env || {}) },
      command,
      args,
      timeoutMs: options.commandTimeoutMs || DEFAULTS.commandTimeoutMs,
    });
    const classified = step.classify(raw);
    return {
      name: step.name,
      outcome: classified.outcome,
      command: commandText,
      notes: classified.notes || "",
      parsed: classified.parsed || null,
    };
  });

  return {
    schema_version: 1,
    relay_home: relayHome,
    repo,
    temp_relay_home: !options.relayHome,
    outcomes: results,
  };
}

function renderMarkdown(result) {
  const lines = [
    "## Live Adapter Dogfood",
    "",
    `- Repo: \`${result.repo}\``,
    `- RELAY_HOME: \`${result.relay_home}\`${result.temp_relay_home ? " (temporary)" : ""}`,
    "",
    "| Step | Outcome | Notes |",
    "| --- | --- | --- |",
  ];
  for (const step of result.outcomes) {
    lines.push(`| \`${step.name}\` | \`${step.outcome}\` | ${String(step.notes || "").replace(/\n/g, "<br>")} |`);
  }
  lines.push("");
  lines.push("Outcome meanings: `pass` proves that live canary path returned the expected structured output; `fail-safe-pass` means the adapter failed safely without producing a reviewable false success; `timeout` is inconclusive; `not-run` is planning/dry-run only.");
  return `${lines.join("\n")}\n`;
}

function printHelp() {
  console.log("Usage: live-dogfood.js --repo <path> [--json|--markdown] [options]");
  console.log("");
  console.log("Runs bounded live multi-executor adapter canaries using a temporary RELAY_HOME by default.");
  console.log("");
  console.log("Options:");
  console.log("  --repo <path>                         Repository root (default: .)");
  console.log("  --relay-home <path>                   Use an explicit RELAY_HOME instead of a temp directory");
  console.log("  --probe-only                          Run only Pi/OpenCode/Antigravity probes");
  console.log("  --dry-run                             Print planned steps without invoking live CLIs");
  console.log("  --json                                Emit structured JSON");
  console.log("  --markdown                            Emit GitHub-comment-ready Markdown");
  console.log("  --pi-model <route>                    Pi route (default: opencode-go/deepseek-v4-pro)");
  console.log("  --opencode-model <route>              OpenCode route (default: opencode-go/deepseek-v4-pro)");
  console.log("  --antigravity-model <route>           Antigravity route (default: google/antigravity-cli)");
  console.log("  --pi-review-timeout <duration>        RELAY_PI_REVIEW_TIMEOUT for the Pi canary (default: 30s)");
  console.log("  --antigravity-review-timeout <duration>  RELAY_ANTIGRAVITY_REVIEW_TIMEOUT (default: 5s)");
  console.log("  --antigravity-dispatch-timeout <sec>  Dispatch timeout seconds (default: 45)");
  console.log("  --command-timeout-ms <ms>             Harness per-command timeout (default: 60000)");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = runDogfood(options);
  if (options.markdown && !options.json) {
    process.stdout.write(renderMarkdown(result));
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (options.markdown) process.stdout.write(`\n${renderMarkdown(result)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  OUTCOMES,
  buildPolicy,
  buildAllowedModelRoutes,
  classifyAntigravityDispatch,
  classifyAntigravityPrimary,
  classifyProbeJson,
  classifyStandardJson,
  ensureRelayHome,
  parseArgs,
  renderMarkdown,
  runDogfood,
};
