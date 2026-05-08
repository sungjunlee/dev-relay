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
const { writeTextFileWithoutFollowingSymlinks } = require("../../relay-dispatch/scripts/manifest/rubric");
const {
  appendSidecarFailed,
  appendSidecarResult,
  appendSidecarStart,
  SIDECAR_TRUST_LEVEL,
  upsertSidecarEntry,
} = require("../../relay-dispatch/scripts/sidecar-store");

const KNOWN_FLAGS = [
  "--run-id", "--kind", "--executor", "--model", "--variant", "--dry-run", "--json", "--help", "-h",
];
const CLI_ARG_OPTIONS = { commandName: "relay-sidecar", reservedFlags: KNOWN_FLAGS };
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

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
    `  --json             ${modeLabel("--json")} Print structured output and store stdout as output.json`,
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

function resolveRunContext({ runId, cwd = process.cwd(), getPrDiff = runGhPrDiff }) {
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
  const prDiff = prNumber === null || prNumber === undefined
    ? ""
    : getPrDiff(prNumber, { cwd: repoRoot });

  return {
    repoRoot,
    manifestPath,
    runDir,
    manifest,
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
    if (args.executor !== "opencode") {
      throw new SidecarFailure(
        `unsupported sidecar executor ${JSON.stringify(args.executor)}; only opencode is wired in this release`,
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
    });
    const outputName = args.json ? "output.json" : "output.md";
    const outputPath = `sidecars/${sidecarId}/${outputName}`;
    const outputDir = getSidecarOutputDir(context.repoRoot, args.runId, sidecarId);
    const outputFullPath = path.join(outputDir, outputName);
    const prompt = buildPrompt({ args, sidecarId, context });
    const command = buildOpencodeCommand({ prompt, model: args.model, cwd: context.worktree });

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
    appendSidecarStart(context.repoRoot, args.runId, {
      id: sidecarId,
      kind: args.kind,
      executor: args.executor,
      model: args.model || null,
      provider: parseProvider(args.model),
    });

    let result;
    try {
      upsertSidecarEntry(context.repoRoot, args.runId, makeEntry({
        sidecarId,
        args,
        status: "running",
        outputPath,
      }));
      const before = snapshotWorktree(context.worktree);
      try {
        result = normalizeRunnerResult(runOpencode(command));
      } catch (error) {
        result = normalizeRunnerResult({
          code: Number.isInteger(error.status) ? error.status : 1,
          stdout: String(error.stdout || ""),
          stderr: String(error.stderr || ""),
          error,
          timedOut: error.code === "ETIMEDOUT",
        });
      }
      const after = snapshotWorktree(context.worktree);

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
