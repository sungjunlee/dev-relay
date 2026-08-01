const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const PROMPT_TRANSPORT_EVIDENCE_ENV =
  "RELAY_REVIEW_PROMPT_TRANSPORT_EVIDENCE_PATH";
const AGY_FILE_REFERENCE_REASON =
  "Antigravity print mode requires a --prompt value, so relay automatically passes only a control-safe file reference through argv.";
const CLINE_FILE_REFERENCE_REASON =
  "Cline JSON mode rejects relay's stdin-only prompt transport as interactive, so relay automatically passes only a control-safe prompt-file reference as the positional prompt argument.";

const FILE_REFERENCE_REASONS = Object.freeze(Object.assign(Object.create(null), {
  antigravity: AGY_FILE_REFERENCE_REASON,
  cline: CLINE_FILE_REFERENCE_REASON,
}));

function reviewedDiffPath(promptFile) {
  const resolved = path.resolve(promptFile);
  const basename = path.basename(resolved);
  const roundPrompt = basename.match(
    /^review-round-(\d+)-prompt\.md$/
  );
  if (roundPrompt) {
    return path.join(
      path.dirname(resolved),
      `review-round-${roundPrompt[1]}-diff.patch`
    );
  }
  return `${resolved} (embedded reviewed diff)`;
}

function promptTransportPolicy(adapter) {
  const reason = FILE_REFERENCE_REASONS[adapter];
  if (reason) {
    return {
      mode: "prompt_file_reference",
      prompt_text_in_argv: false,
      automatic: true,
      compatibility_fallback: true,
      reason,
    };
  }
  return {
    mode: "stdin",
    prompt_text_in_argv: false,
    automatic: true,
    compatibility_fallback: false,
  };
}

function assertControlSafeArgv(args, { adapter, promptFile }) {
  const nulIndex = args.findIndex(
    (entry) => typeof entry === "string" && entry.includes("\0")
  );
  if (nulIndex === -1) return;
  throw new Error(
    `Reviewer prompt transport cannot invoke ${adapter} for diff ${reviewedDiffPath(promptFile)}: ` +
      `argv[${nulIndex}] contains a NUL byte. Remedy: keep the complete review prompt on stdin ` +
      `or in a prompt file and pass only control-safe CLI options through argv.${adapter === "cline"
        ? " Cline must use a workspace-relative positional @file reference; stdin-only JSON transport is unsupported."
        : ""}`
  );
}

function writeTransportEvidence({
  adapter,
  compatibilityFallback,
  mode,
  prompt,
  promptFile,
  reason = null,
}) {
  const evidencePath = process.env[PROMPT_TRANSPORT_EVIDENCE_ENV];
  if (!evidencePath) return null;
  const record = {
    schema_version: 1,
    adapter,
    mode,
    prompt_text_in_argv: false,
    automatic: true,
    compatibility_fallback: compatibilityFallback === true,
    source_prompt_path: path.resolve(promptFile),
    source_diff_path: reviewedDiffPath(promptFile),
    prompt_bytes: Buffer.byteLength(prompt, "utf-8"),
    prompt_sha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    prompt_contains_nul: prompt.includes("\0"),
    ...(reason ? { reason } : {}),
    recorded_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(record, null, 2)}\n`,
    "utf-8"
  );
  return evidencePath;
}

function execFileSyncWithStdinPrompt(
  command,
  args,
  { adapter, prompt, promptFile, ...options }
) {
  assertControlSafeArgv(args, { adapter, promptFile });
  writeTransportEvidence({
    adapter,
    compatibilityFallback: false,
    mode: "stdin",
    prompt,
    promptFile,
  });
  return execFileSync(command, args, {
    ...options,
    input: prompt,
  });
}

function spawnSyncWithStdinPrompt(
  command,
  args,
  { adapter, prompt, promptFile, ...options }
) {
  assertControlSafeArgv(args, { adapter, promptFile });
  writeTransportEvidence({
    adapter,
    compatibilityFallback: false,
    mode: "stdin",
    prompt,
    promptFile,
  });
  return spawnSync(command, args, {
    ...options,
    input: prompt,
  });
}

function createPromptFileReference({ adapter, prompt, promptFile, cwd }) {
  const reason = FILE_REFERENCE_REASONS[adapter];
  if (!reason) {
    throw new Error(
      `Reviewer prompt-file reference transport has no compatibility reason for adapter ${JSON.stringify(adapter)}`
    );
  }

  let transportDir = null;
  try {
    if (adapter === "cline" && !cwd) {
      throw new Error(
        "Cline prompt-file reference transport requires the reviewer cwd"
      );
    }
    const transportRoot = adapter === "cline"
      ? path.resolve(cwd)
      : os.tmpdir();
    const transportPrefix = adapter === "cline"
      ? `.relay-review-${adapter}-prompt-`
      : `relay-review-${adapter}-prompt-`;
    transportDir = fs.mkdtempSync(
      path.join(transportRoot, transportPrefix)
    );
    const transportPromptPath = path.join(transportDir, "review-prompt.md");
    fs.writeFileSync(transportPromptPath, prompt, "utf-8");
    writeTransportEvidence({
      adapter,
      compatibilityFallback: true,
      mode: "prompt_file_reference",
      prompt,
      promptFile,
      reason,
    });
    let promptFileMention = `@${transportPromptPath}`;
    if (adapter === "cline") {
      const relativePromptPath = path.relative(transportRoot, transportPromptPath)
        .split(path.sep)
        .join("/");
      if (
        !relativePromptPath
        || relativePromptPath.startsWith("../")
        || path.isAbsolute(relativePromptPath)
        || /[\s"'`\r\n]/.test(relativePromptPath)
      ) {
        throw new Error(
          "Cline prompt-file reference must be a control-safe workspace-relative path without whitespace or quotes"
        );
      }
      promptFileMention = `@${relativePromptPath}`;
    }
    return {
      directory: transportDir,
      promptPath: transportPromptPath,
      argvReference:
        `Read and follow the complete review instructions in ${promptFileMention}. ` +
        "Return only the JSON requested by that file.",
      cleanup() {
        fs.rmSync(transportDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (transportDir) {
      fs.rmSync(transportDir, { recursive: true, force: true });
    }
    throw error;
  }
}

module.exports = {
  AGY_FILE_REFERENCE_REASON,
  CLINE_FILE_REFERENCE_REASON,
  PROMPT_TRANSPORT_EVIDENCE_ENV,
  assertControlSafeArgv,
  createPromptFileReference,
  execFileSyncWithStdinPrompt,
  promptTransportPolicy,
  reviewedDiffPath,
  spawnSyncWithStdinPrompt,
};
