#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { summarizeFailure } = require("../../relay-dispatch/scripts/manifest/paths");
const {
  bindCliArgs,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const { applyTddFlavorToDispatchPrompt } = require("./tdd-flavor");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--issue", "--planner", "--repo", "--runs-dir", "--out-dir", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "plan-runner",
  reservedFlags: KNOWN_FLAGS,
});

const PLANNER_FIELDS = ["rubric_yaml", "dispatch_prompt_md", "planner_notes_md"];
const NO_HISTORY_TEXT = "no historical data available";
const NO_PROBE_TEXT = "no quality infra detected";

if (require.main === module && (!args.length || cliArgs.hasFlag(["--help", "-h"]))) {
  console.log("Usage: plan-runner.js --issue <N> --planner <codex|claude> --out-dir <path> [options]");
  console.log("\nDraft relay-plan artifacts with an isolated planner adapter.");
  console.log("\nOptions:");
  console.log(`  --issue <N>       ${modeLabel("--issue")} GitHub issue number`);
  console.log(`  --planner <name>  ${modeLabel("--planner")} Planner adapter to invoke (codex|claude)`);
  console.log(`  --repo <path>     ${modeLabel("--repo")} Repository root (default: .)`);
  console.log(`  --runs-dir <path> ${modeLabel("--runs-dir")} Reliability report runs base override`);
  console.log(`  --out-dir <path>  ${modeLabel("--out-dir")} Directory for generated artifacts`);
  console.log(`  --json            ${modeLabel("--json")} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function readIssueBody(repoPath, issueNumber) {
  return execFileSync("gh", ["issue", "view", String(issueNumber), "--json", "body", "-q", ".body"], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function readJsonSignal({ command, args: commandArgs, cwd, env, fallbackText }) {
  try {
    const stdout = execFileSync(command, commandArgs, {
      cwd,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    return JSON.stringify(JSON.parse(stdout), null, 2);
  } catch {
    return fallbackText;
  }
}

function readReliabilitySignal(repoPath, runsDir) {
  const commandArgs = [
    path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "reliability-report.js"),
    "--repo",
    repoPath,
    "--json",
  ];
  const env = runsDir
    ? { ...process.env, RELAY_RUNS_BASE: path.resolve(runsDir) }
    : process.env;
  return readJsonSignal({
    command: process.execPath,
    args: commandArgs,
    cwd: repoPath,
    env,
    fallbackText: NO_HISTORY_TEXT,
  });
}

function readProbeSignal(repoPath) {
  return readJsonSignal({
    command: process.execPath,
    args: [
      path.join(__dirname, "probe-executor-env.js"),
      repoPath,
      "--project-only",
      "--json",
    ],
    cwd: repoPath,
    env: process.env,
    fallbackText: NO_PROBE_TEXT,
  });
}

function replacePlaceholder(template, placeholder, value) {
  if (!template.includes(placeholder)) {
    throw new Error(`Planner prompt template missing placeholder: ${placeholder}`);
  }
  return template.replace(placeholder, value);
}

function buildPrompt({ issueBody, probeSignal, reliabilitySignal }) {
  const templatePath = path.join(__dirname, "..", "references", "planner-prompt.md");
  let prompt = fs.readFileSync(templatePath, "utf-8");
  prompt = replacePlaceholder(prompt, "[PASTE ISSUE BODY HERE]", issueBody);
  prompt = replacePlaceholder(prompt, "[PASTE RELIABILITY SIGNAL HERE]", reliabilitySignal);
  prompt = replacePlaceholder(prompt, "[PASTE PROBE SIGNAL HERE]", probeSignal);
  return prompt;
}

function resolvePlannerScript(planner) {
  if (!/^[a-z0-9-]+$/.test(planner)) {
    throw new Error(`Invalid planner name '${planner}': must be lowercase alphanumeric/hyphens only.`);
  }
  const plannerScript = path.join(__dirname, `invoke-planner-${planner}.js`);
  if (!fs.existsSync(plannerScript)) {
    throw new Error(`No planner adapter found for '${planner}'.`);
  }
  return plannerScript;
}

function parsePlannerOutput(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Planner adapter returned malformed JSON: ${error.message}`);
  }

  for (const field of PLANNER_FIELDS) {
    if (typeof parsed[field] !== "string") {
      throw new Error(`Planner adapter JSON missing string field '${field}'`);
    }
  }

  return {
    rubric_yaml: parsed.rubric_yaml,
    dispatch_prompt_md: parsed.dispatch_prompt_md,
    planner_notes_md: parsed.planner_notes_md,
  };
}

function invokePlanner({ plannerScript, promptPath }) {
  try {
    return execFileSync(process.execPath, [plannerScript, "--prompt-file", promptPath, "--json"], {
      cwd: path.dirname(plannerScript),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new Error(`Planner adapter failed: ${summarizeFailure(error)}`);
  }
}

function writeArtifacts(outDir, plannerOutput) {
  const resolvedOutDir = path.resolve(outDir);
  fs.mkdirSync(resolvedOutDir, { recursive: true });
  const paths = {
    rubric_yaml: path.join(resolvedOutDir, "rubric.yaml"),
    dispatch_prompt_md: path.join(resolvedOutDir, "dispatch-prompt.md"),
    planner_notes_md: path.join(resolvedOutDir, "planner-notes.md"),
  };
  fs.writeFileSync(paths.rubric_yaml, `${plannerOutput.rubric_yaml.replace(/\s*$/, "")}\n`, "utf-8");
  fs.writeFileSync(paths.dispatch_prompt_md, `${plannerOutput.dispatch_prompt_md.replace(/\s*$/, "")}\n`, "utf-8");
  fs.writeFileSync(paths.planner_notes_md, `${plannerOutput.planner_notes_md.replace(/\s*$/, "")}\n`, "utf-8");
  return paths;
}

function applyPlannerPostProcessing(plannerOutput, probeSignal) {
  return {
    ...plannerOutput,
    dispatch_prompt_md: applyTddFlavorToDispatchPrompt({
      dispatchPrompt: plannerOutput.dispatch_prompt_md,
      rubricYaml: plannerOutput.rubric_yaml,
      probeSignal,
    }),
  };
}

function printResult(result, jsonOut) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("Planner artifacts written");
  console.log(`  Rubric:          ${result.artifacts.rubric_yaml}`);
  console.log(`  Dispatch prompt: ${result.artifacts.dispatch_prompt_md}`);
  console.log(`  Planner notes:   ${result.artifacts.planner_notes_md}`);
}

function run() {
  const issueNumber = cliArgs.getArg("--issue");
  const planner = cliArgs.getArg("--planner");
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const runsDir = cliArgs.getArg("--runs-dir");
  const outDir = cliArgs.getArg("--out-dir");
  const jsonOut = cliArgs.hasFlag("--json");

  if (!issueNumber) throw new Error("--issue is required");
  if (!planner) throw new Error("--planner is required");
  if (!outDir) throw new Error("--out-dir is required");

  const plannerScript = resolvePlannerScript(planner);
  let promptDir = null;

  try {
    const issueBody = readIssueBody(repoPath, issueNumber);
    const reliabilitySignal = readReliabilitySignal(repoPath, runsDir);
    const probeSignal = readProbeSignal(repoPath);
    const prompt = buildPrompt({ issueBody, reliabilitySignal, probeSignal });

    promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-runner-"));
    const promptPath = path.join(promptDir, "planner-prompt.md");
    fs.writeFileSync(promptPath, `${prompt.replace(/\s*$/, "")}\n`, "utf-8");

    const rawOutput = invokePlanner({ plannerScript, promptPath });
    const plannerOutput = parsePlannerOutput(rawOutput);
    const processedOutput = applyPlannerPostProcessing(plannerOutput, probeSignal);
    const artifactPaths = writeArtifacts(outDir, processedOutput);

    printResult({
      issue: Number(issueNumber),
      planner,
      artifacts: artifactPaths,
    }, jsonOut);
  } finally {
    if (promptDir) {
      fs.rmSync(promptDir, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildPrompt,
  parsePlannerOutput,
  applyPlannerPostProcessing,
  readProbeSignal,
  readReliabilitySignal,
  resolvePlannerScript,
};
