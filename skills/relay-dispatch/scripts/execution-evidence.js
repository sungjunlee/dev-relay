const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  RUNTIME_METADATA_ROOTS,
} = require("./runtime-dirt");

const EXECUTION_EVIDENCE_FILENAME = "execution-evidence.json";
const EXECUTION_EVIDENCE_SCHEMA_VERSION = 1;
const VERIFICATION_OUTPUT_FILENAME = "verification-gates.log";
const VERIFICATION_REQUEST_BEGIN = "RELAY_VERIFICATION_REQUEST_BEGIN";
const VERIFICATION_REQUEST_END = "RELAY_VERIFICATION_REQUEST_END";
const VERIFICATION_RESULT_BEGIN = "RELAY_VERIFICATION_RESULT_BEGIN";
const VERIFICATION_RESULT_END = "RELAY_VERIFICATION_RESULT_END";
const MAX_VERIFICATION_OUTPUT_BYTES = 1024 * 1024;
const SHA40_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const VERIFICATION_HASH_FIELDS = ["output_hash", "stdout_hash", "stderr_hash"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function verificationRunsMalformation(verificationRuns) {
  if (!Array.isArray(verificationRuns)) {
    const valueType = verificationRuns === null ? "null" : typeof verificationRuns;
    return `verification_runs must be an array when present; found ${valueType}`;
  }
  if (verificationRuns.length === 0) {
    return "verification_runs must not be empty when present";
  }

  for (let index = 0; index < verificationRuns.length; index += 1) {
    const run = verificationRuns[index];
    if (!run || typeof run !== "object" || Array.isArray(run)) {
      return `verification_runs[${index}] must be a JSON object`;
    }
    if (!isNonEmptyString(run.command)) {
      return `verification_runs[${index}].command must be a non-empty string`;
    }
    if (!isNonEmptyString(run.cwd)) {
      return `verification_runs[${index}].cwd must be a non-empty string`;
    }
    if (!isNonEmptyString(run.head_sha) || !SHA40_PATTERN.test(run.head_sha)) {
      return `verification_runs[${index}].head_sha must be a 40-character hex SHA`;
    }
    if (
      run.verification_tree_sha !== undefined
      && (!isNonEmptyString(run.verification_tree_sha)
        || !SHA40_PATTERN.test(run.verification_tree_sha))
    ) {
      return `verification_runs[${index}].verification_tree_sha must be a 40-character hex Git tree SHA when present`;
    }
    if (!Number.isInteger(run.exit_code) || run.exit_code < 0) {
      return `verification_runs[${index}].exit_code must be a non-negative integer`;
    }
    if (!isNonEmptyString(run.recorded_by)) {
      return `verification_runs[${index}].recorded_by must be a non-empty string`;
    }
    if (!isNonEmptyString(run.recorded_at) || Number.isNaN(Date.parse(run.recorded_at))) {
      return `verification_runs[${index}].recorded_at must be a valid ISO timestamp`;
    }
    for (const fieldName of VERIFICATION_HASH_FIELDS) {
      const value = run[fieldName];
      if (value !== undefined && (!isNonEmptyString(value) || !SHA256_PATTERN.test(value))) {
        return `verification_runs[${index}].${fieldName} must be a sha256 hex digest when present`;
      }
    }
    if (run.output_path !== undefined && !isNonEmptyString(run.output_path)) {
      return `verification_runs[${index}].output_path must be a non-empty string when present`;
    }
    if (!VERIFICATION_HASH_FIELDS.some((fieldName) => isNonEmptyString(run[fieldName]))) {
      return (
        `verification_runs[${index}] requires at least one of ` +
        VERIFICATION_HASH_FIELDS.join(", ")
      );
    }
  }

  return null;
}

function verificationRunsValueType(verificationRuns) {
  if (verificationRuns === null) return "null";
  if (Array.isArray(verificationRuns)) return "array";
  return typeof verificationRuns;
}

function verificationRunHeadShas(verificationRuns) {
  if (!Array.isArray(verificationRuns)) return [];
  return [...new Set(verificationRuns
    .filter((run) => run && typeof run === "object" && !Array.isArray(run))
    .map((run) => run.head_sha)
    .filter(isNonEmptyString))];
}

function yamlKeyMatch(line) {
  return String(line || "").match(/^(\s*)(?:-\s*)?([A-Za-z_][\w.-]*):\s*(.*?)\s*$/);
}

function yamlBlockEnd(lines, start, indent, limit = lines.length) {
  for (let index = start + 1; index < limit; index += 1) {
    if (/^\s*(?:#.*)?$/.test(lines[index])) continue;
    const currentIndent = lines[index].match(/^\s*/)[0].length;
    if (currentIndent <= indent) return index;
  }
  return limit;
}

function findYamlKey(lines, key, start, end, parentIndent = -1) {
  const matches = [];
  let directIndent = null;
  for (let index = start; index < end; index += 1) {
    const match = yamlKeyMatch(lines[index]);
    if (!match || match[1].length <= parentIndent) continue;
    const candidate = { index, indent: match[1].length, key: match[2], value: match[3] };
    matches.push(candidate);
    if (directIndent === null || candidate.indent < directIndent) directIndent = candidate.indent;
  }
  if (directIndent === null) return null;
  return matches.find((match) => match.key === key && match.indent === directIndent) || null;
}

function decodeYamlScalar(rawValue, lines, index, indent, end) {
  const value = String(rawValue || "").trim();
  if (/^[|>][+-]?$/.test(value)) {
    const content = [];
    let contentIndent = null;
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (/^\s*$/.test(lines[cursor])) {
        content.push("");
        continue;
      }
      const currentIndent = lines[cursor].match(/^\s*/)[0].length;
      if (currentIndent <= indent) break;
      if (contentIndent === null) contentIndent = currentIndent;
      content.push(lines[cursor].slice(Math.min(contentIndent, currentIndent)));
    }
    return value.startsWith(">")
      ? content.join(" ").replace(/\s+/g, " ").trim()
      : content.join("\n").trim();
  }
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function verificationCheckBlocks(rubricYaml) {
  const lines = String(rubricYaml || "").split(/\r?\n/);
  const evaluation = findYamlKey(lines, "evaluation", 0, lines.length);
  if (!evaluation || evaluation.value) return [];
  const evaluationEnd = yamlBlockEnd(lines, evaluation.index, evaluation.indent);
  const verification = findYamlKey(
    lines,
    "verification",
    evaluation.index + 1,
    evaluationEnd,
    evaluation.indent
  );
  if (!verification || verification.value) return [];
  const verificationEnd = yamlBlockEnd(lines, verification.index, verification.indent, evaluationEnd);
  const checks = findYamlKey(
    lines,
    "checks",
    verification.index + 1,
    verificationEnd,
    verification.indent
  );
  if (!checks || checks.value) return [];
  const checksEnd = yamlBlockEnd(lines, checks.index, checks.indent, verificationEnd);
  const starts = [];
  let itemIndent = null;
  for (let index = checks.index + 1; index < checksEnd; index += 1) {
    const item = lines[index].match(/^(\s*)-\s+/);
    if (!item) continue;
    const indent = item[1].length;
    if (itemIndent === null) itemIndent = indent;
    if (indent === itemIndent) starts.push(index);
  }
  return starts.map((start, position) => ({
    end: starts[position + 1] || checksEnd,
    itemIndent,
    lines,
    start,
  }));
}

function scalarFromVerificationCheck(block, key) {
  for (let index = block.start; index < block.end; index += 1) {
    const match = yamlKeyMatch(block.lines[index]);
    if (!match || match[2] !== key) continue;
    const isItemField = index === block.start && match[1].length === block.itemIndent;
    const isNestedField = index > block.start && match[1].length > block.itemIndent;
    if (!isItemField && !isNestedField) continue;
    return decodeYamlScalar(match[3], block.lines, index, match[1].length, block.end);
  }
  return "";
}

function parseVerificationGateFields(rubricYaml) {
  return verificationCheckBlocks(rubricYaml).map((block, index) => {
    const name = scalarFromVerificationCheck(block, "name") || `verification.checks[${index}]`;
    const type = scalarFromVerificationCheck(block, "type");
    const command = scalarFromVerificationCheck(block, "command");
    return { name, type, command };
  });
}

// Compatibility contract: existing callers treat every check with a command as
// executable regardless of its rubric type. Only an explicitly command-typed
// check without a command is malformed; all other commandless checks are ignored.
function extractVerificationGates(rubricYaml) {
  return parseVerificationGateFields(rubricYaml).map((gate) => {
    const { name, type, command } = gate;
    if (type === "command" && !command.trim()) {
      throw new Error(`verification gate '${name}' did not record a command for execution evidence`);
    }
    return gate;
  }).filter((gate) => gate.command.trim());
}

// The operator recorder additionally recognizes explicit observations. Legacy
// non-command types remain command gates when they carry a command, matching
// extractVerificationGates(), and are otherwise ignored.
function extractVerificationGateDefinitions(rubricYaml) {
  return parseVerificationGateFields(rubricYaml).flatMap((gate) => {
    if (gate.type === "observation") return [{ ...gate, type: "observation" }];
    if (gate.command.trim()) return [{ ...gate, type: "command" }];
    if (gate.type === "command") {
      throw new Error(`verification gate '${gate.name}' did not record a command for execution evidence`);
    }
    return [];
  });
}

function resolveExecutionEvidenceTestCommand({ explicitTestCommand, rubricYaml } = {}) {
  if (explicitTestCommand !== undefined && explicitTestCommand !== null) {
    return explicitTestCommand;
  }
  const commands = extractVerificationGates(rubricYaml).map((gate) => gate.command);
  if (!commands.length) return undefined;
  return commands.length === 1 ? commands[0] : commands.join(" && ");
}

function hashFileSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verificationTreeProofGitAddArgs() {
  return [
    "add",
    "-A",
    "--",
    ".",
    ...RUNTIME_METADATA_ROOTS.flatMap((root) => [
      `:(exclude)${root}`,
      `:(exclude)${root}/**`,
    ]),
  ];
}

function verificationTreeProofTrackedGitAddArgs() {
  /*
   * The first proof add deliberately excludes runtime roots so untracked
   * executor metadata cannot enter the verification tree. Overlay every
   * tracked worktree update afterward: `git add -u` records modifications and
   * deletions beneath those roots without adding their untracked neighbors.
   */
  return ["add", "-u", "--", "."];
}

function verificationTreeProofStagedRuntimeAdditionsGitDiffArgs() {
  /*
   * A path added under a runtime root exists only in the repository's real
   * index, so `git add -u` cannot discover it from the HEAD-seeded proof
   * index. Use the real index only to identify those intentionally staged
   * paths. The proof index must read their gate-time content, mode, or deletion
   * from the worktree instead of trusting a possibly stale staged blob.
   */
  return [
    "diff",
    "--cached",
    "--ita-visible-in-index",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--diff-filter=A",
    "--",
    ...RUNTIME_METADATA_ROOTS,
  ];
}

function verificationTreeProofStagedRuntimeAdditionsGitUpdateIndexArgs() {
  /*
   * `update-index --stdin -z` consumes literal NUL-delimited repository paths,
   * stages current worktree content and executable mode, and removes a listed
   * path that disappeared after it was staged. That makes the proof describe
   * what the gates observed while the real index remains read-only.
   */
  return ["update-index", "--add", "--remove", "-z", "--stdin"];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildExecutorVerificationInstructions(gates) {
  if (!Array.isArray(gates) || gates.length === 0) return "";
  const request = {
    schema_version: 1,
    gates: gates.map(({ name, command }) => ({ name, command })),
  };
  const reviewableGitAddCommand = [
    'GIT_INDEX_FILE="$verification_index"',
    "git",
    ...verificationTreeProofGitAddArgs().map(shellQuote),
  ].join(" ");
  const trackedGitAddCommand = [
    'GIT_INDEX_FILE="$verification_index"',
    "git",
    ...verificationTreeProofTrackedGitAddArgs().map(shellQuote),
  ].join(" ");
  const stagedRuntimeAdditionsCommand = [
    'GIT_INDEX_FILE="$verification_real_index"',
    "git",
    ...verificationTreeProofStagedRuntimeAdditionsGitDiffArgs().map(shellQuote),
    '> "$verification_runtime_paths"',
  ].join(" ");
  const stageGateTimeRuntimeAdditionsCommand = [
    'GIT_INDEX_FILE="$verification_index"',
    "git",
    ...verificationTreeProofStagedRuntimeAdditionsGitUpdateIndexArgs().map(shellQuote),
    '< "$verification_runtime_paths"',
  ].join(" ");
  return [
    "## Required executor-side verification",
    "",
    "After completing the task, run every command below inside this same executor session.",
    "The commands must remain subject to the executor's current sandbox and network policy.",
    "Do not delegate them back to the relay orchestrator and do not expose credentials or secret environment values.",
    "After all required gates finish, capture the exact reviewable repository state with the temporary Git index commands below.",
    "Use the repository's real index only as a read-only source for intentionally staged runtime-root additions; untracked, unstaged executor runtime metadata must stay excluded, while tracked runtime-root modifications and deletions remain reviewable.",
    "The staged-addition allowlist is refreshed from the gate-time worktree, so later content, mode, and deletion state are proven instead of a stale staged blob.",
    "",
    'verification_real_index="$(git rev-parse --git-path index)"',
    'verification_index="$(mktemp)"',
    'verification_runtime_paths="$(mktemp)"',
    'rm -f "$verification_index"',
    'GIT_INDEX_FILE="$verification_index" git read-tree HEAD',
    reviewableGitAddCommand,
    trackedGitAddCommand,
    stagedRuntimeAdditionsCommand,
    `if test -s "$verification_runtime_paths"; then ${stageGateTimeRuntimeAdditionsCommand} || { rm -f "$verification_runtime_paths" "$verification_index"; echo "failed to refresh staged runtime additions from the gate-time worktree" >&2; exit 1; }; fi`,
    'verification_tree_sha="$(GIT_INDEX_FILE="$verification_index" git write-tree)"',
    'rm -f "$verification_runtime_paths" "$verification_index"',
    "",
    "Capture this proof before any later commit or commit hook can mutate the tree, then report it as verification_tree_sha.",
    "",
    VERIFICATION_REQUEST_BEGIN,
    JSON.stringify(request),
    VERIFICATION_REQUEST_END,
    "",
    "At the end of your final response, append exactly one result envelope using this shape:",
    VERIFICATION_RESULT_BEGIN,
    '{"schema_version":1,"verification_tree_sha":"40-hex Git tree SHA captured after all gates and before commit","runs":[{"command":"exact command from request","exit_code":0,"output":"captured stdout/stderr"}]}',
    VERIFICATION_RESULT_END,
    "Preserve each command verbatim, keep request order, and report a nonzero exit_code when policy blocks a command.",
  ].join("\n");
}

function parseExecutorVerificationResult(resultText) {
  const text = String(resultText || "").replace(/\r\n/g, "\n").trimEnd();
  if (!text.includes(VERIFICATION_RESULT_BEGIN)) {
    throw new Error("executor did not return the required verification result envelope");
  }
  const endToken = `\n${VERIFICATION_RESULT_END}`;
  if (!text.endsWith(endToken) && text !== VERIFICATION_RESULT_END) {
    throw new Error("executor verification result envelope must be the final response content");
  }
  const endIndex = text.length - VERIFICATION_RESULT_END.length - (
    text.endsWith(endToken) ? 1 : 0
  );
  const beforeEnd = text.slice(0, endIndex);
  const beginToken = `${VERIFICATION_RESULT_BEGIN}\n`;
  const beginLineIndex = beforeEnd.lastIndexOf(`\n${beginToken}`);
  const beginIndex = beginLineIndex === -1
    ? (beforeEnd.startsWith(beginToken) ? 0 : -1)
    : beginLineIndex + 1;
  if (beginIndex === -1) {
    throw new Error("executor did not return the required verification result envelope");
  }
  const jsonStart = beginIndex + beginToken.length;

  let result;
  try {
    result = JSON.parse(text.slice(jsonStart, endIndex).trim());
  } catch (error) {
    throw new Error(`executor verification result must be valid JSON: ${error.message}`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("executor verification result must be a JSON object");
  }
  if (result.schema_version !== 1) {
    throw new Error(`unsupported executor verification schema_version=${result.schema_version}`);
  }
  if (!Array.isArray(result.runs)) {
    throw new Error("executor verification result runs must be an array");
  }
  return result;
}

function validateVerificationTreeProof(verificationTreeSha, finalTreeSha) {
  if (!isNonEmptyString(verificationTreeSha) || !SHA40_PATTERN.test(verificationTreeSha)) {
    throw new Error(
      "verification_tree_proof_invalid: executor verification result verification_tree_sha " +
      "must be an exact 40-character hex Git tree SHA captured after all required gates and " +
      "before any later commit or hook; re-run the executor verification gates at the committed HEAD"
    );
  }
  if (!isNonEmptyString(finalTreeSha) || !SHA40_PATTERN.test(finalTreeSha)) {
    throw new Error(
      "verification_tree_proof_invalid: final HEAD^{tree} did not resolve to an exact " +
      "40-character hex Git tree SHA; repair the commit and re-run the executor verification gates"
    );
  }
  if (verificationTreeSha.toLowerCase() !== finalTreeSha.toLowerCase()) {
    throw new Error(
      "verification_tree_mismatch: executor verification ran against tree " +
      `${verificationTreeSha}, but final HEAD^{tree} is ${finalTreeSha}; ` +
      "re-run the executor verification gates at the committed HEAD and report a new tree proof"
    );
  }
  return verificationTreeSha.toLowerCase();
}

function collectExecutorVerificationEvidence({
  gates,
  cwd,
  headSha,
  finalTreeSha,
  runDir,
  resultText,
  executor,
  recordedAt,
} = {}) {
  if (!Array.isArray(gates) || gates.length === 0) {
    return { runs: [], outputPath: null, exitCode: undefined };
  }
  if (!cwd || !headSha || !finalTreeSha || !runDir) {
    throw new Error("executor verification evidence requires cwd, headSha, finalTreeSha, and runDir");
  }

  const result = parseExecutorVerificationResult(resultText);
  const verificationTreeSha = validateVerificationTreeProof(
    result.verification_tree_sha,
    finalTreeSha
  );
  if (result.runs.length !== gates.length) {
    throw new Error(
      `executor verification result recorded ${result.runs.length} runs for ${gates.length} required gates`
    );
  }

  const aggregateOutputPath = path.join(runDir, VERIFICATION_OUTPUT_FILENAME);
  const aggregateChunks = [];
  const runs = gates.map((gate, index) => {
    const confirmed = result.runs[index];
    if (!confirmed || typeof confirmed !== "object" || Array.isArray(confirmed)) {
      throw new Error(`executor verification runs[${index}] must be a JSON object`);
    }
    if (confirmed.command !== gate.command) {
      throw new Error(
        `executor verification runs[${index}].command did not match required gate '${gate.name}'`
      );
    }
    if (!Number.isInteger(confirmed.exit_code) || confirmed.exit_code < 0) {
      throw new Error(
        `executor verification runs[${index}].exit_code must be a non-negative integer`
      );
    }
    if (typeof confirmed.output !== "string") {
      throw new Error(`executor verification runs[${index}].output must be a string`);
    }
    if (Buffer.byteLength(confirmed.output, "utf-8") > MAX_VERIFICATION_OUTPUT_BYTES) {
      throw new Error(
        `executor verification runs[${index}].output exceeds ${MAX_VERIFICATION_OUTPUT_BYTES} bytes`
      );
    }

    const outputName = `verification-gate-${index + 1}.log`;
    const outputPath = path.join(runDir, outputName);
    const output = Buffer.from(confirmed.output, "utf-8");
    fs.writeFileSync(outputPath, output);
    aggregateChunks.push(Buffer.from(
      `${index ? "\n" : ""}$ ${gate.command}\n`,
      "utf-8"
    ));
    aggregateChunks.push(output);
    if (output.length && output[output.length - 1] !== 0x0a) {
      aggregateChunks.push(Buffer.from("\n", "utf-8"));
    }

    return {
      name: gate.name,
      command: gate.command,
      cwd,
      head_sha: headSha,
      verification_tree_sha: verificationTreeSha,
      exit_code: confirmed.exit_code,
      output_path: outputName,
      output_hash: hashFileSha256(outputPath),
      recorded_by: `${executor || "executor"}-confirmed-verification-v1`,
      recorded_at: recordedAt || new Date().toISOString(),
    };
  });
  fs.writeFileSync(aggregateOutputPath, Buffer.concat(aggregateChunks));

  const failedRun = runs.find((run) => run.exit_code !== 0);
  return {
    runs,
    outputPath: aggregateOutputPath,
    exitCode: failedRun ? failedRun.exit_code : 0,
    verificationTreeSha,
  };
}

function buildExecutionEvidence({
  headSha,
  testCommand,
  resultFilePath,
  executor,
  recordedAt,
  testExitCode,
  verificationRuns,
  browserEvidence,
}) {
  if (!headSha) {
    throw new Error("post-dispatch HEAD SHA is required for execution evidence");
  }

  const resultHash = hashFileSha256(resultFilePath);
  return {
    schema_version: EXECUTION_EVIDENCE_SCHEMA_VERSION,
    head_sha: headSha,
    test_command: testCommand === undefined || testCommand === null ? "unspecified" : testCommand,
    test_result_hash: resultHash || "unspecified",
    test_result_summary: resultHash ? `${executor || "executor"} result.txt hashed` : "unspecified",
    ...(testExitCode !== undefined ? { test_exit_code: testExitCode } : {}),
    ...(verificationRuns !== undefined ? { verification_runs: verificationRuns } : {}),
    ...(browserEvidence !== undefined ? { browser_evidence: browserEvidence } : {}),
    recorded_at: recordedAt || new Date().toISOString(),
    recorded_by: "dispatch-orchestrator-v1",
  };
}

function writeExecutionEvidence(runDir, evidence, options = {}) {
  const finalPath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  const tmpPath = options.tmpPath || path.join(
    runDir,
    `${EXECUTION_EVIDENCE_FILENAME}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
  return finalPath;
}

function rebrandEvidence(runDir, { newHeadSha, recordedBy = "recover-commit-rebrand", reason } = {}) {
  const evidencePath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  if (!fs.existsSync(evidencePath)) {
    return { skipped: "no_existing_evidence" };
  }
  if (!/^[0-9a-f]{40}$/.test(newHeadSha || "")) {
    return { skipped: "rejected_bad_sha", reason: "newHeadSha must be a 40-character lowercase hex SHA" };
  }

  const existing = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  if (existing.head_sha === newHeadSha) {
    return { skipped: "sha_unchanged" };
  }

  const previousSha = existing.head_sha;
  const verificationRunsPresent = Object.prototype.hasOwnProperty.call(existing, "verification_runs");
  const previousVerificationRuns = existing.verification_runs;
  const verificationRunsMalformed = verificationRunsPresent
    ? verificationRunsMalformation(previousVerificationRuns)
    : null;
  const {
    verification_runs: _staleVerificationRuns,
    ...rebrandedEvidence
  } = existing;
  const verificationRunsAudit = !verificationRunsPresent
    ? {}
    : verificationRunsMalformed
      ? {
          verification_runs: {
            policy: "removed_malformed_after_rebrand",
            removed_value_type: verificationRunsValueType(previousVerificationRuns),
            malformation_reason: verificationRunsMalformed,
            removed_value: previousVerificationRuns,
            previous_head_shas: verificationRunHeadShas(previousVerificationRuns),
            next_action: "re-verify at the new HEAD or record audited operator evidence",
          },
        }
      : {
          verification_runs: {
            policy: "removed_stale_after_rebrand",
            removed_count: previousVerificationRuns.length,
            previous_head_shas: verificationRunHeadShas(previousVerificationRuns),
            removed_runs: previousVerificationRuns,
            next_action: "re-verify at the new HEAD or record audited operator evidence",
          },
        };
  const previousRebrandHistory = Array.isArray(existing.rebrand_history)
    ? existing.rebrand_history
    : [];
  const previousRebrand = existing.rebrand
    && typeof existing.rebrand === "object"
    && !Array.isArray(existing.rebrand)
    ? existing.rebrand
    : null;
  const rebrandHistory = previousRebrand
    ? [...previousRebrandHistory, previousRebrand]
    : previousRebrandHistory;
  const rebrand = {
    previous_head_sha: previousSha,
    new_head_sha: newHeadSha,
    previous_recorded_by: existing.recorded_by,
    reason,
    recorded_at: new Date().toISOString(),
    ...verificationRunsAudit,
  };
  writeExecutionEvidence(runDir, {
    ...rebrandedEvidence,
    head_sha: newHeadSha,
    recorded_by: recordedBy,
    ...(rebrandHistory.length ? { rebrand_history: rebrandHistory } : {}),
    rebrand,
  });

  return {
    rewritten: true,
    previousSha,
    newHeadSha,
    evidencePath,
    evidenceHash: hashFileSha256(evidencePath),
    ...(verificationRunsPresent
      ? {
          verificationRunsPolicy: verificationRunsMalformed
            ? "removed_malformed_after_rebrand"
            : "removed_stale_after_rebrand",
          ...(Array.isArray(previousVerificationRuns)
            ? { removedVerificationRuns: previousVerificationRuns.length }
            : {}),
          ...(verificationRunsMalformed
            ? { verificationRunsMalformation: verificationRunsMalformed }
            : {}),
        }
      : {}),
  };
}

module.exports = {
  EXECUTION_EVIDENCE_FILENAME,
  EXECUTION_EVIDENCE_SCHEMA_VERSION,
  VERIFICATION_OUTPUT_FILENAME,
  buildExecutionEvidence,
  buildExecutorVerificationInstructions,
  collectExecutorVerificationEvidence,
  extractVerificationGateDefinitions,
  extractVerificationGates,
  hashFileSha256,
  rebrandEvidence,
  resolveExecutionEvidenceTestCommand,
  verificationTreeProofGitAddArgs,
  verificationTreeProofStagedRuntimeAdditionsGitDiffArgs,
  verificationTreeProofStagedRuntimeAdditionsGitUpdateIndexArgs,
  verificationTreeProofTrackedGitAddArgs,
  writeExecutionEvidence,
};
