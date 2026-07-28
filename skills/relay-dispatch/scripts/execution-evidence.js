const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EXECUTION_EVIDENCE_FILENAME = "execution-evidence.json";
const EXECUTION_EVIDENCE_SCHEMA_VERSION = 1;

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

function extractVerificationGates(rubricYaml) {
  return verificationCheckBlocks(rubricYaml).map((block, index) => {
    const name = scalarFromVerificationCheck(block, "name") || `verification.checks[${index}]`;
    const type = scalarFromVerificationCheck(block, "type");
    const command = scalarFromVerificationCheck(block, "command");
    if (type === "command" && !command.trim()) {
      throw new Error(`verification gate '${name}' did not record a command for execution evidence`);
    }
    return { name, type, command };
  }).filter((gate) => gate.command.trim());
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

function rebrandEvidence(
  runDir,
  { newHeadSha, recordedBy = "recover-commit-rebrand", reason, testCommand } = {}
) {
  const evidencePath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  if (!fs.existsSync(evidencePath)) {
    return { skipped: "no_existing_evidence" };
  }
  if (!/^[0-9a-f]{40}$/.test(newHeadSha || "")) {
    return { skipped: "rejected_bad_sha", reason: "newHeadSha must be a 40-character lowercase hex SHA" };
  }

  const existing = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  const shouldSeedTestCommand = (
    (existing.test_command === undefined || existing.test_command === null || existing.test_command === "unspecified")
    && typeof testCommand === "string"
    && testCommand.trim() !== ""
  );
  if (existing.head_sha === newHeadSha && !shouldSeedTestCommand) {
    return { skipped: "sha_unchanged" };
  }

  const previousSha = existing.head_sha;
  writeExecutionEvidence(runDir, {
    ...existing,
    head_sha: newHeadSha,
    ...(shouldSeedTestCommand ? { test_command: testCommand } : {}),
    recorded_by: recordedBy,
    rebrand: {
      previous_head_sha: previousSha,
      previous_recorded_by: existing.recorded_by,
      reason,
      recorded_at: new Date().toISOString(),
      ...(shouldSeedTestCommand ? { test_command_seeded_from_verification_gates: true } : {}),
    },
  });

  return {
    rewritten: true,
    previousSha,
    newHeadSha,
    testCommandSeeded: shouldSeedTestCommand,
    evidencePath,
    evidenceHash: hashFileSha256(evidencePath),
  };
}

module.exports = {
  EXECUTION_EVIDENCE_FILENAME,
  EXECUTION_EVIDENCE_SCHEMA_VERSION,
  buildExecutionEvidence,
  extractVerificationGates,
  hashFileSha256,
  rebrandEvidence,
  resolveExecutionEvidenceTestCommand,
  writeExecutionEvidence,
};
