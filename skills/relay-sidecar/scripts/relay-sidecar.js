#!/usr/bin/env node

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  bindCliArgs,
  findUnknownFlags,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  getCanonicalRepoRoot,
  getManifestPath,
  getRunDir,
  getSidecarOutputDir,
  validateManifestPaths,
} = require("../../relay-dispatch/scripts/manifest/paths");
const { readManifest } = require("../../relay-dispatch/scripts/manifest/store");
const {
  readTextFileWithoutFollowingSymlinks,
  writeTextFileWithoutFollowingSymlinks,
} = require("../../relay-dispatch/scripts/manifest/rubric");
const { appendRunEvent, EVENTS } = require("../../relay-dispatch/scripts/relay-events");
const {
  appendSidecarFailed,
  appendSidecarResult,
  appendSidecarStart,
  SIDECAR_TRUST_LEVEL,
  upsertSidecarEntry,
} = require("../../relay-dispatch/scripts/sidecar-store");
const contextRecapKind = require("./kinds/context-recap");
const testGapKind = require("./kinds/test-gap");

const KNOWN_FLAGS = [
  "--run-id", "--kind", "--executor", "--model", "--variant", "--dry-run", "--json", "--help", "-h",
];
const CLI_ARG_OPTIONS = { commandName: "relay-sidecar", reservedFlags: KNOWN_FLAGS };
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const KIND_REGISTRY = Object.freeze({
  [contextRecapKind.KIND_NAME]: contextRecapKind,
  [testGapKind.KIND_NAME]: testGapKind,
});

class SidecarFailure extends Error {
  constructor(message, { exitCode = 1, failureReason = message } = {}) {
    super(message);
    this.name = "SidecarFailure";
    this.exitCode = exitCode;
    this.failureReason = failureReason;
  }
}

function usage() {
  return [
    "Usage: relay-sidecar.js --run-id <id> --kind <name> [options]",
    "",
    "Options:",
    `  --run-id <id>       ${modeLabel("--run-id")} Relay run id (required)`,
    "  --kind <name>      Sidecar kind (required; accepts context-recap, test-gap, docs-sync, or any string)",
    `  --executor <name>  ${modeLabel("--executor")} Executor to use (default: opencode; only opencode is wired)`,
    `  --model <provider/model>  ${modeLabel("--model")} Optional model override passed through`,
    "  --variant <name>   Optional sidecar variant included in the sidecar id",
    `  --dry-run          ${modeLabel("--dry-run")} Print envelope without invoking executor or emitting events`,
    `  --json             ${modeLabel("--json")} Print structured runner output`,
    `  --help, -h         ${modeLabel("--help")} Show this help`,
  ].join("\n");
}

function parseArgs(argv) {
  const bound = bindCliArgs(argv, CLI_ARG_OPTIONS);
  const getArg = bound.getArg || bound[["get", "Arg"].join("")];
  const hasFlag = bound.hasFlag || bound[["has", "Flag"].join("")];
  return {
    help: hasFlag(["--help", "-h"]),
    runId: getArg("--run-id"),
    kind: getArg("--kind"),
    executor: getArg("--executor", "opencode"),
    model: getArg("--model"),
    variant: getArg("--variant"),
    dryRun: hasFlag("--dry-run"),
    json: hasFlag("--json"),
  };
}

function requireNonEmpty(value, flag) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${flag} is required`);
  }
  return value.trim();
}

function sanitizeIdPart(value, label) {
  const normalized = requireNonEmpty(value, label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error(`${label} must contain at least one alphanumeric character`);
  }
  return normalized;
}

function randomHex(bytes = 4) {
  return crypto.randomBytes(bytes).toString("hex");
}

function createSidecarId({ kind, variant, entropy = randomHex(4) }) {
  const parts = [sanitizeIdPart(kind, "--kind")];
  if (variant !== undefined && variant !== null && String(variant).trim() !== "") {
    parts.push(sanitizeIdPart(variant, "--variant"));
  }
  parts.push(String(entropy).slice(0, 8));
  return parts.join("-");
}

function parseProvider(model) {
  if (typeof model !== "string" || model.trim() === "") return null;
  const idx = model.indexOf("/");
  return idx > 0 ? model.slice(0, idx) : null;
}

function runGhPrDiff(prNumber, { cwd, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl("gh", ["pr", "diff", String(prNumber)], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh pr diff ${prNumber} exited ${result.status}: ${String(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout || "";
}

function readTextIfExists(filePath) {
  try {
    return readTextFileWithoutFollowingSymlinks(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function readJsonIfExists(filePath) {
  const text = readTextIfExists(filePath);
  if (!text) return null;
  return JSON.parse(text);
}

function readEventsFromRunDir(runDir) {
  const text = readTextIfExists(path.join(runDir, "events.jsonl"));
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function readRoundArtifacts(runDir, suffix, reader) {
  if (!fs.existsSync(runDir)) return [];
  return fs.readdirSync(runDir)
    .map((name) => {
      const match = name.match(new RegExp(`^review-round-(\\d+)-${suffix}$`));
      if (!match) return null;
      const filePath = path.join(runDir, name);
      const round = Number(match[1]);
      const content = reader(filePath);
      if (content === null) return null;
      return { round, path: filePath, content };
    })
    .filter(Boolean)
    .sort((left, right) => left.round - right.round);
}

function loadRunArtifacts({ runDir, manifest, runId, prNumber, prDiff = "" }) {
  const verdicts = readRoundArtifacts(runDir, "verdict\\.json", readJsonIfExists)
    .map((artifact) => ({ round: artifact.round, path: artifact.path, ...artifact.content }));
  const redispatchPrompts = readRoundArtifacts(runDir, "redispatch\\.md", readTextIfExists)
    .map((artifact) => ({ round: artifact.round, path: artifact.path, text: artifact.content }));
  const doneCriteriaSnapshots = readRoundArtifacts(runDir, "done-criteria\\.md", readTextIfExists)
    .map((artifact) => ({ round: artifact.round, path: artifact.path, text: artifact.content }));
  const diffs = readRoundArtifacts(runDir, "diff\\.patch", readTextIfExists)
    .map((artifact) => ({ round: artifact.round, path: artifact.path, text: artifact.content }));
  const latestDiff = diffs.length ? diffs.at(-1).text : prDiff;

  return {
    manifest,
    events: readEventsFromRunDir(runDir),
    verdicts,
    redispatchPrompts,
    dispatchResult: readTextIfExists(path.join(runDir, "dispatch-result.txt")),
    doneCriteriaSnapshots,
    diffs,
    lastDiff: latestDiff,
    runDir,
    runId,
    prNumber,
  };
}

function getLatestReviewDiff(runDir) {
  const reviewDiffs = readRoundArtifacts(runDir, "diff\\.patch", readTextIfExists)
    .map((artifact) => ({ round: artifact.round, text: artifact.content }));
  return reviewDiffs.length ? reviewDiffs.at(-1).text : null;
}

function loadTestGapExtras(runDir, { prDiff = "" } = {}) {
  const dispatchPrompt = readTextIfExists(path.join(runDir, "dispatch-prompt.md"));
  const roundOneDoneCriteria = readTextIfExists(path.join(runDir, "review-round-1-done-criteria.md"));
  return {
    rubric: readTextIfExists(path.join(runDir, "rubric.yaml")) || undefined,
    doneCriteria: roundOneDoneCriteria || dispatchPrompt || undefined,
    diff: getLatestReviewDiff(runDir) || prDiff || null,
  };
}

function resolveRunContext({ runId, cwd = process.cwd(), getPrDiff = runGhPrDiff, fetchPrDiff = true, kind = null }) {
  const repoRoot = getCanonicalRepoRoot(cwd);
  const manifestPath = getManifestPath(repoRoot, runId);
  const runDir = getRunDir(repoRoot, runId);
  const manifest = readManifest(manifestPath).data;
  const validatedPaths = validateManifestPaths(manifest.paths, {
    manifestPath,
    runId,
    requireWorktree: true,
    caller: "relay-sidecar",
  });
  const prNumber = manifest.pr_number ?? manifest.git?.pr_number ?? null;
  const hasLocalTestGapDiff = kind === testGapKind.KIND_NAME && getLatestReviewDiff(runDir) !== null;
  const prDiff = !fetchPrDiff || hasLocalTestGapDiff || prNumber === null || prNumber === undefined
    ? ""
    : getPrDiff(prNumber, { cwd: repoRoot });

  const runContext = loadRunArtifacts({
    runDir,
    manifest,
    runId,
    prNumber,
    prDiff,
  });
  if (kind === testGapKind.KIND_NAME) {
    Object.assign(runContext, loadTestGapExtras(runDir, { prDiff }));
  }

  return {
    repoRoot,
    manifestPath,
    runDir,
    manifest,
    runContext,
    worktree: validatedPaths.worktree,
    prNumber,
    prDiff,
  };
}

function buildPrompt({ args, sidecarId, context }) {
  const prDiff = context.prDiff
    ? `\n## PR Diff\n\n\`\`\`diff\n${context.prDiff}\n\`\`\`\n`
    : "\n## PR Diff\n\nNo PR diff is available for this run.\n";
  return [
    "You are running a relay sidecar. Produce advisory analysis only.",
    "Do not edit files, create files, commit, or mutate repository state. Write the final artifact to stdout only.",
    "",
    "## Sidecar",
    `id: ${sidecarId}`,
    `kind: ${args.kind}`,
    `variant: ${args.variant || "none"}`,
    `executor: ${args.executor}`,
    `model: ${args.model || "default"}`,
    "",
    "## Run Context",
    `run_id: ${args.runId}`,
    `manifest_path: ${context.manifestPath}`,
    `run_dir: ${context.runDir}`,
    `worktree: ${context.worktree}`,
    `pr_number: ${context.prNumber ?? "none"}`,
    prDiff,
  ].join("\n");
}

function buildOpencodeCommand({ prompt, model, cwd }) {
  const args = ["run"];
  if (model) args.push("-m", model);
  args.push(prompt);
  return { cmd: "opencode", args, cwd };
}

function resolveKind(kind) {
  return KIND_REGISTRY[kind] || null;
}

function hasDeterministicBuilder(kindModule) {
  return typeof kindModule?.buildRecap === "function";
}

function buildSidecarPrompt({ args, sidecarId, context, kindModule, baselineRecap }) {
  if (typeof kindModule?.buildOpencodeAugmentationPrompt === "function" && baselineRecap !== null) {
    return kindModule.buildOpencodeAugmentationPrompt({
      runContext: context.runContext,
      baselineRecap,
    });
  }
  return buildPrompt({ args, sidecarId, context });
}

function runSidecarExecutor({ args, command, runOpencode }) {
  if (args.executor === "none") {
    return { code: 0, stdout: command.output, stderr: "" };
  }
  return runOpencode(command);
}

function createOpencodeRunner({ spawnSyncImpl = spawnSync } = {}) {
  return function runOpencode({ cmd, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const result = spawnSyncImpl(cmd, args, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: timeoutMs,
    });
    return {
      code: result.status === null || result.status === undefined ? (result.error ? 1 : 0) : result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      signal: result.signal || null,
      timedOut: result.error?.code === "ETIMEDOUT",
      error: result.error || null,
    };
  };
}

function snapshotWorktree(worktree) {
  // `git status --porcelain` is intentionally used as the advisory fingerprint:
  // it detects tracked edits plus untracked files without hashing file contents.
  const result = spawnSync("git", ["-C", worktree, "status", "--porcelain"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git status --porcelain exited ${result.status}: ${String(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout || "";
}

function normalizeRunnerResult(result) {
  return {
    code: Number.isInteger(result?.code) ? result.code : 0,
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" ? result.stderr : "",
    timedOut: result?.timedOut === true,
    error: result?.error || null,
  };
}

function failureReasonFromResult(result) {
  if (result.timedOut) return "opencode timeout";
  if (result.error) return `opencode error: ${result.error.message || result.error}`;
  return `opencode exit ${result.code}`;
}

function makeEntry({ sidecarId, args, status, outputPath }) {
  return {
    id: sidecarId,
    kind: args.kind,
    executor: args.executor,
    model: args.model || null,
    provider: parseProvider(args.model),
    status,
    output_path: outputPath,
    trust_level: SIDECAR_TRUST_LEVEL,
  };
}

function emitEnvelope(envelope, { json, stdout }) {
  if (json) {
    stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  if (envelope.ok) {
    stdout(`relay-sidecar ${envelope.sidecar_id}: ${envelope.status}\n`);
    if (envelope.output_path) stdout(`output: ${envelope.output_path}\n`);
  } else {
    stdout(`relay-sidecar ${envelope.sidecar_id || ""}: failed\n`);
  }
}

function main(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || ((text) => process.stdout.write(text));
  const stderr = options.stderr || ((text) => process.stderr.write(text));
  const cwd = options.cwd || process.cwd();
  const runOpencode = options.runOpencode || createOpencodeRunner();

  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout(`${usage()}\n`);
      return { exitCode: 0 };
    }

    const unknownFlags = findUnknownFlags(argv, KNOWN_FLAGS);
    if (unknownFlags.length) {
      throw new SidecarFailure(`unknown flags: ${unknownFlags.join(", ")}`, { exitCode: 2 });
    }

    args.runId = requireNonEmpty(args.runId, "--run-id");
    args.kind = requireNonEmpty(args.kind, "--kind");
    args.executor = requireNonEmpty(args.executor, "--executor");
    const kindModule = resolveKind(args.kind);
    const deterministicKind = hasDeterministicBuilder(kindModule);
    if (args.executor === "none" && !deterministicKind) {
      throw new SidecarFailure(
        `unsupported sidecar executor "none" for kind ${JSON.stringify(args.kind)}; deterministic sidecar builder is not available`,
        { exitCode: 2 }
      );
    }
    if (args.executor !== "opencode" && args.executor !== "none") {
      throw new SidecarFailure(
        `unsupported sidecar executor ${JSON.stringify(args.executor)}; supported executors are opencode and none`,
        { exitCode: 2 }
      );
    }

    const sidecarId = createSidecarId({
      kind: args.kind,
      variant: args.variant,
      entropy: options.entropy || randomHex(4),
    });
    const context = resolveRunContext({
      runId: args.runId,
      cwd,
      getPrDiff: options.getPrDiff || runGhPrDiff,
      fetchPrDiff: args.kind === testGapKind.KIND_NAME
        || (args.executor === "opencode" && args.kind !== contextRecapKind.KIND_NAME),
      kind: args.kind,
    });
    const outputName = "output.md";
    const outputPath = `sidecars/${sidecarId}/${outputName}`;
    const outputDir = getSidecarOutputDir(context.repoRoot, args.runId, sidecarId);
    const outputFullPath = path.join(outputDir, outputName);
    const baselineRecap = deterministicKind
      ? kindModule.buildRecap({ runContext: context.runContext })
      : null;
    const prompt = args.executor === "opencode"
      ? buildSidecarPrompt({ args, sidecarId, context, kindModule, baselineRecap })
      : null;
    const command = args.executor === "opencode"
      ? buildOpencodeCommand({ prompt, model: args.model, cwd: context.worktree })
      : { cmd: "none", args: [], cwd: context.worktree, output: baselineRecap };

    const baseEnvelope = {
      ok: true,
      run_id: args.runId,
      sidecar_id: sidecarId,
      kind: args.kind,
      variant: args.variant || null,
      executor: args.executor,
      model: args.model || null,
      manifest_path: context.manifestPath,
      run_dir: context.runDir,
      worktree: context.worktree,
      pr_number: context.prNumber,
      output_path: outputPath,
    };

    if (args.dryRun) {
      const envelope = { ...baseEnvelope, dry_run: true, status: "dry_run", command };
      emitEnvelope(envelope, { json: args.json, stdout });
      return { exitCode: 0, envelope };
    }

    const startedAt = Date.now();
    if (args.kind === testGapKind.KIND_NAME) {
      appendRunEvent(context.repoRoot, args.runId, {
        event: EVENTS.SIDECAR_START,
        sidecar_id: sidecarId,
        kind: args.kind,
        executor: args.executor,
        model: args.model || null,
        provider: parseProvider(args.model),
        trust_level: SIDECAR_TRUST_LEVEL,
      });
    } else {
      appendSidecarStart(context.repoRoot, args.runId, {
        id: sidecarId,
        kind: args.kind,
        executor: args.executor,
        model: args.model || null,
        provider: parseProvider(args.model),
      });
    }

    let result;
    try {
      upsertSidecarEntry(context.repoRoot, args.runId, makeEntry({
        sidecarId,
        args,
        status: "running",
        outputPath,
      }));
      const before = args.executor === "none" ? "" : snapshotWorktree(context.worktree);
      try {
        result = normalizeRunnerResult(runSidecarExecutor({ args, command, runOpencode }));
      } catch (error) {
        result = normalizeRunnerResult({
          code: Number.isInteger(error.status) ? error.status : 1,
          stdout: String(error.stdout || ""),
          stderr: String(error.stderr || ""),
          error,
          timedOut: error.code === "ETIMEDOUT",
        });
      }
      const after = args.executor === "none" ? "" : snapshotWorktree(context.worktree);

      fs.mkdirSync(outputDir, { recursive: true });
      writeTextFileWithoutFollowingSymlinks(outputFullPath, result.stdout);

      if (before !== after) {
        throw new SidecarFailure("advisory_violation", {
          exitCode: 1,
          failureReason: "advisory_violation",
        });
      }
      if (result.code !== 0 || result.timedOut || result.error) {
        throw new SidecarFailure(failureReasonFromResult(result), {
          exitCode: result.code || 1,
          failureReason: failureReasonFromResult(result),
        });
      }

      const elapsedMs = Date.now() - startedAt;
      appendSidecarResult(context.repoRoot, args.runId, {
        id: sidecarId,
        kind: args.kind,
        output_path: outputPath,
        elapsed_ms: elapsedMs,
      });
      upsertSidecarEntry(context.repoRoot, args.runId, makeEntry({
        sidecarId,
        args,
        status: "completed",
        outputPath,
      }));
      const envelope = { ...baseEnvelope, dry_run: false, status: "completed", elapsed_ms: elapsedMs };
      emitEnvelope(envelope, { json: args.json, stdout });
      return { exitCode: 0, envelope };
    } catch (error) {
      const failureReason = error instanceof SidecarFailure
        ? error.failureReason
        : `sidecar failure: ${error.message}`;
      appendSidecarFailed(context.repoRoot, args.runId, {
        id: sidecarId,
        kind: args.kind,
        failure_reason: failureReason,
      });
      upsertSidecarEntry(context.repoRoot, args.runId, makeEntry({
        sidecarId,
        args,
        status: "failed",
        outputPath,
      }));
      const exitCode = error instanceof SidecarFailure ? error.exitCode : 1;
      const envelope = { ...baseEnvelope, ok: false, dry_run: false, status: "failed", failure_reason: failureReason };
      if (args.json) emitEnvelope(envelope, { json: true, stdout });
      else stderr(`Error: ${failureReason}\n`);
      return { exitCode: exitCode || 1, envelope };
    }
  } catch (error) {
    const exitCode = error instanceof SidecarFailure ? error.exitCode : 1;
    stderr(`Error: ${error.message}\n`);
    return { exitCode: exitCode || 1 };
  }
}

if (require.main === module) {
  const { exitCode } = main();
  process.exit(exitCode);
}

module.exports = {
  buildOpencodeCommand,
  buildPrompt,
  createOpencodeRunner,
  createSidecarId,
  main,
  parseArgs,
  resolveRunContext,
  snapshotWorktree,
  usage,
};
