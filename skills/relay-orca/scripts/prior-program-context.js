"use strict";

// Read-only context locator boundary for #1021. A context contains paths only;
// the accepted program, receipt, and evidence are parsed afresh and passed to
// Leaf 1's pure verifier on every probe attempt.
const fs = require("node:fs");
const path = require("node:path");
const { verifyClosedProgram } = require("./lib/closed-program-proof");
const { validateReceipt } = require("./lib/receipt");
const { resolveRepoContext } = require("./receipt-io");
const { programSegment } = require("./lib/program-segment");

const BLOCKING_PROOF_CODES = new Set([
  "PROOF_TASK_ACTIVE",
  "PROOF_TASK_FAILED",
  "PROOF_TASK_MARKER_MISMATCH",
  "PROOF_GATE_PENDING",
  "PROOF_GATE_FAILED",
  "PROOF_GATE_DUPLICATE",
  "PROOF_GATE_NONCANONICAL",
  "PROOF_GATE_CONFLICT",
  "PROOF_GATE_MALFORMED",
  "PROOF_OUTCOME_FAILED",
  "PROOF_OUTCOME_INCOMPLETE",
  "PROOF_STOPPED",
  "PROOF_EVIDENCE_FAILED",
]);

class PriorProgramContextError extends Error {
  constructor(message) {
    super(message);
    this.name = "PriorProgramContextError";
  }
}

function object(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredPath(value, label, baseDir) {
  const candidate = object(value) ? value.path : value;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new PriorProgramContextError(`${label} must locate a non-empty path`);
  }
  if (candidate.includes("\0")) throw new PriorProgramContextError(`${label} contains a control character`);
  return path.resolve(baseDir, candidate);
}

function optionalPath(value, label, baseDir) {
  if (value === undefined || value === null) return null;
  return requiredPath(value, label, baseDir);
}

function readJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new PriorProgramContextError(`${label} is unreadable: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new PriorProgramContextError(`${label} is not valid JSON: ${error.message}`);
  }
}

function contextLocator(value, contextPath) {
  if (typeof value === "string") return value;
  if (!object(value)) throw new PriorProgramContextError("prior-program context is not an object");
  if (value.schema !== 1) throw new PriorProgramContextError("prior-program context schema must be 1");
  const baseDir = path.dirname(contextPath);
  const repoValue = value.repo_root !== undefined ? value.repo_root : value.repo;
  const repoSlug = object(repoValue) && repoValue.slug !== undefined ? repoValue.slug : null;
  const repoRoot = requiredPath(object(repoValue) ? repoValue.root : repoValue, "context repo_root", baseDir);
  const accepted = value.accepted_program !== undefined
    ? value.accepted_program
    : value.acceptedProgram !== undefined
      ? value.acceptedProgram
      : value.accepted_program_path !== undefined
        ? value.accepted_program_path
      : value.program_path !== undefined
        ? value.program_path
        : value.program;
  const receipt = value.canonical_receipt !== undefined ? value.canonical_receipt : value.receipt;
  const evidence = value.trusted_evidence !== undefined
    ? value.trusted_evidence
    : value.evidence !== undefined
      ? value.evidence
      : value.trusted_evidence_path !== undefined
        ? value.trusted_evidence_path
        : (value.durable_outcome_evidence !== undefined || value.durable_outcome_evidence_path !== undefined || value.trusted_generic_integration_evidence !== undefined || value.trusted_generic_integration_evidence_path !== undefined)
          ? {
              durable_outcomes: value.durable_outcome_evidence !== undefined ? value.durable_outcome_evidence : value.durable_outcome_evidence_path,
              generic_integration: value.trusted_generic_integration_evidence !== undefined ? value.trusted_generic_integration_evidence : value.trusted_generic_integration_evidence_path,
            }
          : undefined;
  const programPath = requiredPath(accepted, "accepted program", baseDir);
  const receiptPath = requiredPath(value.receipt_path !== undefined ? value.receipt_path : value.canonical_receipt_path !== undefined ? value.canonical_receipt_path : receipt, "canonical receipt", baseDir);
  if (typeof evidence === "string" || object(evidence) && "path" in evidence) {
    return {
      schema: 1,
      repoRoot,
      repoSlug,
      programPath,
      receiptPath,
      durablePath: requiredPath(evidence, "durable outcome evidence", baseDir),
      genericPath: null,
    };
  }
  if (!object(evidence)) throw new PriorProgramContextError("trusted_evidence must locate evidence files");
  const durableValue = evidence.durable_outcomes !== undefined
    ? evidence.durable_outcomes
    : evidence.durable_outcome_evidence !== undefined
      ? evidence.durable_outcome_evidence
      : evidence.durable_outcome_evidence_path !== undefined
        ? evidence.durable_outcome_evidence_path
      : evidence.durable_evidence !== undefined
        ? evidence.durable_evidence
        : evidence.durable;
  const durablePath = requiredPath(durableValue, "durable outcome evidence", baseDir);
  const genericValue = evidence.generic_integration !== undefined
    ? evidence.generic_integration
    : evidence.generic_integration_evidence !== undefined
      ? evidence.generic_integration_evidence
      : evidence.generic_integration_evidence_path !== undefined
        ? evidence.generic_integration_evidence_path
      : evidence.trusted_generic_integration_evidence !== undefined
        ? evidence.trusted_generic_integration_evidence
        : evidence.generic;
  const genericPath = optionalPath(genericValue, "generic integration evidence", baseDir);
  return { schema: 1, repoRoot, repoSlug, programPath, receiptPath, durablePath, genericPath };
}

function loadOne(locatorInput, contextPath, targetRepo, snapshot) {
  const locator = contextLocator(locatorInput, contextPath);
  const contextRepo = resolveRepoContext({ repoRootOverride: locator.repoRoot });
  if (contextRepo.root !== targetRepo.root || contextRepo.slug !== targetRepo.slug || (locator.repoSlug !== null && locator.repoSlug !== contextRepo.slug)) {
    throw new PriorProgramContextError(`prior-program context repo does not match the target repository`);
  }
  const programValue = readJson(locator.programPath, "accepted program");
  const program = programValue && programValue.program && object(programValue.program) ? programValue.program : programValue;
  if (!object(program) || typeof program.id !== "string" || program.id.trim() === "") {
    throw new PriorProgramContextError("accepted program id is missing");
  }
  const receipt = readJson(locator.receiptPath, "canonical receipt");
  const receiptError = validateReceipt(receipt);
  if (receiptError) throw new PriorProgramContextError(`canonical receipt is invalid: ${receiptError}`);
  if (receipt.program_id !== program.id || receipt.repo.slug !== targetRepo.slug || receipt.repo.root !== targetRepo.root) {
    throw new PriorProgramContextError(`canonical receipt identity does not match the target repository and accepted program`);
  }
  const durableOutcomeEvidence = readJson(locator.durablePath, "durable outcome evidence");
  const trustedGenericIntegrationEvidence = locator.genericPath
    ? readJson(locator.genericPath, "generic integration evidence")
    : undefined;
  const proof = verifyClosedProgram({
    acceptedProgram: program,
    receipt,
    durableOutcomeEvidence,
    trustedGenericIntegrationEvidence,
    orcaSnapshot: snapshot,
    programSegment,
  });
  if (proof.ok !== true && !BLOCKING_PROOF_CODES.has(proof.reasonCode)) {
    throw new PriorProgramContextError(`prior-program proof ${program.id} failed with ${proof.reasonCode || "PROOF_MALFORMED_INPUT"}`);
  }
  return { contextPath, program, receipt, proof };
}

function loadPriorProgramContexts({ inputs, repoRoot, snapshot }) {
  const rawInputs = Array.isArray(inputs) ? inputs.slice() : [];
  if (rawInputs.length === 0) return [];
  const targetRepo = resolveRepoContext({ repoRootOverride: repoRoot });
  const paths = rawInputs.map((input) => {
    if (typeof input !== "string" || input.trim() === "") throw new PriorProgramContextError("prior-program context path is missing");
    return path.resolve(process.cwd(), input);
  });
  const unique = new Set(paths);
  if (unique.size !== paths.length) throw new PriorProgramContextError("prior-program context is duplicated");
  const contexts = paths.map((contextPath) => loadOne(readJson(contextPath, "prior-program context"), contextPath, targetRepo, snapshot));
  contexts.sort((left, right) => left.program.id.localeCompare(right.program.id) || left.contextPath.localeCompare(right.contextPath));
  return contexts;
}

module.exports = { PriorProgramContextError, loadPriorProgramContexts, contextLocator };
