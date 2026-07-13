#!/usr/bin/env node
"use strict";

// relay-orca `status` — strictly READ-ONLY live reconciler (issue #945). It derives a
// normalized program view from the reconstructible receipt, relay manifests, GitHub,
// and Orca runtime signals. Durable truth outranks runtime signals; `worker_done` is
// NEVER completion evidence. It performs NO mutation of any kind: no GitHub write, no
// relay manifest write, no Orca mutating subcommand, no receipt write. Repair is out
// of scope in this leaf — `status` emits `repair_candidates` diagnostics only.
//
// Per the architectural constraint, ALL subprocess and filesystem I/O lives HERE and
// in receipt-io.js; the pure scripts/lib/ modules receive injected read adapters.
const { execFileSync } = require("node:child_process");
const {
  CanonicalizationError,
  resolveRepoContext,
  receiptPathFor,
  readReceiptFile,
  receiptExists,
  listManifestFiles,
  listFleetManifestFiles,
  makeUrlResolver,
  writeReceiptAtomic,
  programSegment,
} = require("./receipt-io");
const { resolveOrcaBin } = require("./lib/resolve-orca-bin");
const { parseReceipt, serializeReceiptWithRecords } = require("./lib/receipt");
const { boundedExcerpt } = require("./lib/bounded-excerpt");
const { parseManifest } = require("./lib/manifest-parse");
const { deriveStatusReport } = require("./lib/status-derive");
const { StatusError, USAGE_EXIT, reject } = require("./lib/status-reasons");
const { evaluateGates } = require("./lib/gate-evaluate");
const { orderGatesReport, orderFinalSummary } = require("./lib/gate-report");
const { deriveProposals, mergeFollowUps, upsertRecordedFollowUps } = require("./lib/follow-ups");
const { buildFinalSummary } = require("./lib/final-summary");
const { REASONS: GATE_REASONS } = require("./lib/gate-reasons");

const fs = require("node:fs");
const path = require("node:path");
const READ_TIMEOUT_MS = 15000;
const READ_MAX_BUFFER = 4 * 1024 * 1024;

function usageError(message) {
  process.stderr.write(`relay-orca status: ${message}\n`);
  process.stderr.write(
    "usage: status.js --program-id <id> [--json] [--gates | --final-summary] [--program-file <accepted-program.json>] " +
      "[--gate-evidence-dir <dir>] [--record-proposals] [--strict] [--orca-bin <path>] [--gh-bin <path>] [--repo-root <path>]\n",
  );
  process.exit(USAGE_EXIT);
}

function requireValue(value, flag) {
  if (!value || value.startsWith("-")) usageError(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = {
    programId: null,
    json: false,
    orcaBin: null,
    ghBin: null,
    repoRoot: null,
    help: false,
    // #947 read-only status modes. `--gates`/`--final-summary` are mutually exclusive
    // status modes; both stay READ-ONLY unless `--record-proposals` is passed (D9.12).
    gates: false,
    finalSummary: false,
    recordProposals: false,
    strict: false,
    programFile: null,
    gateEvidenceDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--program-id" || arg === "-p") opts.programId = requireValue(argv[(i += 1)], "--program-id");
    else if (arg === "--json") opts.json = true;
    else if (arg === "--gates") opts.gates = true;
    else if (arg === "--final-summary") opts.finalSummary = true;
    else if (arg === "--record-proposals") opts.recordProposals = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--program-file") opts.programFile = requireValue(argv[(i += 1)], "--program-file");
    else if (arg === "--gate-evidence-dir") opts.gateEvidenceDir = requireValue(argv[(i += 1)], "--gate-evidence-dir");
    else if (arg === "--orca-bin") opts.orcaBin = requireValue(argv[(i += 1)], "--orca-bin");
    else if (arg === "--gh-bin") opts.ghBin = requireValue(argv[(i += 1)], "--gh-bin");
    else if (arg === "--repo-root") opts.repoRoot = requireValue(argv[(i += 1)], "--repo-root");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else usageError(`unrecognized argument: ${arg}`);
  }
  if (opts.gates && opts.finalSummary) usageError("--gates and --final-summary are mutually exclusive");
  if (opts.recordProposals && !opts.gates) usageError("--record-proposals is only valid with --gates");
  return opts;
}

// Structural read-only refusal for Orca (belt-and-suspenders alongside the fixture
// poisons): no mutating orchestration subcommand, no reset, no worktree ever runs.
function assertOrcaReadOnly(argv) {
  const mutating = argv.includes("reset")
    || argv.includes("worktree")
    || argv.includes("task-create")
    || argv.includes("task-update")
    || (argv[0] === "orchestration" && argv[1] === "dispatch")
    || argv[0] === "terminal";
  if (mutating) {
    throw new Error(`relay-orca status must never invoke a mutating Orca subcommand (got: ${argv.join(" ")})`);
  }
}

// A28: `gh api` body/field options that make the request default to a mutating POST.
// Present in ANY of these forms, an `api` call is a write even without a literal `-X`.
const GH_API_BODY_OPTS = new Set(["-f", "--field", "-F", "--raw-field", "--input"]);

function isGhApiBodyOption(token) {
  if (GH_API_BODY_OPTS.has(token)
    || token.startsWith("--field=")
    || token.startsWith("--raw-field=")
    || token.startsWith("--input=")) return true;

  // Cobra permits boolean shorthands to be clustered before a value-taking flag.
  // For `gh api`, `-i` is boolean, so `-ifa=b` and `-iFa=b` carry body fields.
  // Stop at any other shorthand because a value-taking flag (notably `-XGET`)
  // consumes the remainder of its token as its value.
  if (!token.startsWith("-") || token.startsWith("--")) return false;
  let index = 1;
  while (token[index] === "i") index += 1;
  return token[index] === "f" || token[index] === "F";
}

// Extract an explicit `gh api` method, handling both separated (`-X POST`, `--method POST`)
// and attached (`-XPOST`, `--method=POST`) forms. Returns null when no method is specified
// (a bare `gh api` defaults to GET).
function ghApiMethod(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-X" || token === "--method") return String(argv[i + 1] || "");
    if (token.startsWith("--method=")) return token.slice("--method=".length);
    if (token.startsWith("-X") && token.length > 2) return token.slice(2);
  }
  return null;
}

// A28: a `gh api` invocation is mutation-shaped (defaults to POST/PATCH/PUT/DELETE) when it
// carries any body/field option OR an explicit non-GET method. A bare `gh api <path>` (no
// method, no body/field) is a read-only GET.
function isMutatingGhApi(argv) {
  if (argv[0] !== "api") return false;
  if (argv.some((token) => isGhApiBodyOption(token))) return true;
  const method = ghApiMethod(argv);
  if (method !== null && method.trim().toUpperCase() !== "GET") return true;
  return argv.some((token) => /^(POST|PATCH|PUT|DELETE)$/i.test(token));
}

// Structural read-only refusal for gh: only `issue view`, `pr view`, and read-shaped
// `api` GETs are permitted (D3). Any write subcommand — including a mutation-shaped `gh api`
// carrying body/field options or an explicit non-GET method (A28) — is refused before it runs.
function assertGhReadOnly(argv) {
  const isIssueView = argv[0] === "issue" && argv[1] === "view";
  const isPrView = argv[0] === "pr" && argv[1] === "view";
  const isApiRead = argv[0] === "api" && !isMutatingGhApi(argv);
  if (!isIssueView && !isPrView && !isApiRead) {
    throw new Error(`relay-orca status must never invoke a non-read gh subcommand (got: ${argv.join(" ")})`);
  }
}

// Every read runner is pinned to the selected repository's root via `cwd` (#945 A9).
// A repo-scoped `gh` invocation resolves the PR/issue against THIS repo's origin
// remote, so running `status` from an unrelated directory can never read a different
// repository's GitHub state. `cwd` is the slug-verified canonical repo root (the
// receipt's repo, guaranteed on disk and matched against the receipt slug before any
// read runs).
function makeRunner(bin, assertReadOnly, cwd) {
  if (!bin) return null;
  return (_bin, args) => {
    const argv = (Array.isArray(args) ? args : []).map(String);
    assertReadOnly(argv);
    try {
      const stdout = execFileSync(bin, argv, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        cwd: cwd || undefined,
        timeout: READ_TIMEOUT_MS,
        maxBuffer: READ_MAX_BUFFER,
      });
      return { status: 0, stdout: String(stdout || ""), stderr: "" };
    } catch (error) {
      return {
        status: typeof error.status === "number" ? error.status : 1,
        stdout: error.stdout ? String(error.stdout) : "",
        stderr: error.stderr ? String(error.stderr) : "",
      };
    }
  };
}

function loadReceipt(receiptPath, requestedProgramId) {
  if (!receiptExists(receiptPath)) {
    reject("RECEIPT_NOT_FOUND", `no receipt found at ${receiptPath}`);
  }
  const parsed = parseReceipt(readReceiptFile(receiptPath));
  if (!parsed.ok) reject("RECEIPT_CORRUPT", parsed.reason);
  // Identity check (#945 A6): the receipt loaded from the requested program's path MUST
  // carry the same program_id. A mismatch means the file at this path belongs to a
  // different program (hand-edit, misplaced write, or a sanitized-segment collision that
  // the stable hash is meant to prevent) — fail closed rather than reconcile the wrong
  // program. Both ids are bounded so a pathological receipt id cannot inflate the error.
  if (parsed.receipt.program_id !== requestedProgramId) {
    reject(
      "RECEIPT_CORRUPT",
      `receipt program_id ${boundedExcerpt(parsed.receipt.program_id)} does not match the requested --program-id ${boundedExcerpt(requestedProgramId)}`,
    );
  }
  return parsed.receipt;
}

function resolveGhBin(opts) {
  if (opts.ghBin) return opts.ghBin;
  const env = process.env.RELAY_ORCA_GH_BIN;
  return env && env.trim() !== "" ? env.trim() : "gh";
}

function resolveOrca(opts) {
  const resolved = resolveOrcaBin({ orcaBinOverride: opts.orcaBin || null });
  return resolved.path || null;
}

function printReport(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`relay-orca status for ${report.program_id} (runtime=${report.runtime}, program_state=${report.program_state})\n`);
  report.outcomes.forEach((outcome) => {
    process.stdout.write(`  ${outcome.outcome_id} [${outcome.state}] kind=${outcome.kind} wave=${outcome.wave}\n`);
  });
  report.diagnostics.forEach((diagnostic) => {
    process.stdout.write(`  diagnostic [${diagnostic.code}] ${diagnostic.outcome_id || "-"}: ${diagnostic.message}\n`);
  });
}

function failStatus(error, json) {
  const body = { ok: false, reason_code: error.reasonCode, message: error.message, remediation: error.remediation || "" };
  if (json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else process.stderr.write(`relay-orca status rejected [${error.reasonCode}]: ${error.message}\n`);
  process.exit(error.exitCode);
}

// The SAME read-only reconciliation the plain `status` path builds (#945), factored out
// so the #947 read-only modes (`--gates`, `--final-summary`) reconcile identically before
// evaluating gates. Returns { report, receipt, receiptPath, repo }. Throws
// StatusError/CanonicalizationError, which main() maps to the fail-closed exit codes.
function gatherReconciliation(opts) {
  const repo = resolveRepoContext({ repoRootOverride: opts.repoRoot });
  const receiptPath = receiptPathFor(repo.slug, opts.programId);
  const receipt = loadReceipt(receiptPath, opts.programId);
  if (receipt.repo && receipt.repo.slug !== repo.slug) {
    reject("RECEIPT_REPO_MISMATCH", `receipt repo.slug ${receipt.repo.slug} does not match the current repo slug ${repo.slug}`);
  }
  // Child run manifests come from the runs root; fleet manifests come from the
  // SEPARATE fleets root (#945 A8). A fleet outcome's `relay_ids.fleet` resolves to a
  // fleet manifest here, while its children still resolve against the runs-root map.
  const manifests = listManifestFiles(repo.slug).map((entry) => ({
    run_id: entry.run_id,
    text: entry.text,
    parsed: parseManifest(entry.text),
  }));
  const fleetManifests = listFleetManifestFiles(repo.slug).map((entry) => ({
    run_id: entry.run_id,
    text: entry.text,
    parsed: parseManifest(entry.text),
  }));
  const report = deriveStatusReport({
    receipt,
    programId: opts.programId,
    receiptPath,
    manifests,
    fleetManifests,
    orca: makeRunner(resolveOrca(opts), assertOrcaReadOnly, repo.root),
    gh: makeRunner(resolveGhBin(opts), assertGhReadOnly, repo.root),
    urlFor: makeUrlResolver(repo.root),
    // A26: the foreign-task marker embeds the SAME collision-resistant segment used for
    // the receipt path, injected as a pure function (lib/ stays subprocess-free).
    programSegment,
  });
  return { report, receipt, receiptPath, repo };
}

// Read the accepted program's exit_gates VERBATIM (#947 D1). Exit gates are INPUT
// artifacts — they come ONLY from the program file, never from the receipt or an invented
// default. The program id must match the receipt's program id (a mismatch is an operator
// input error → usage 64). The root may be the program object directly or wrapped under a
// `program` key (same as the frozen compiler's unwrap).
function readProgramExitGates(programFile, receiptProgramId) {
  if (!programFile) usageError("--gates/--final-summary require --program-file (exit gates come only from the accepted program)");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(programFile, "utf-8"));
  } catch (error) {
    usageError(`cannot read program file ${programFile}: ${error.message}`);
  }
  const program = parsed && parsed.program && typeof parsed.program === "object" ? parsed.program : parsed;
  if (!program || typeof program !== "object") usageError(`program file ${programFile} is not a program object`);
  if (program.id !== receiptProgramId) {
    usageError(`program file id ${boundedExcerpt(program.id)} does not match the receipt program id ${boundedExcerpt(receiptProgramId)}`);
  }
  if (!Array.isArray(program.exit_gates) || program.exit_gates.length === 0) {
    usageError(`program file ${programFile} has no exit_gates array`);
  }
  return { exitGates: program.exit_gates, decisionGates: Array.isArray(program.decision_gates) ? program.decision_gates : [] };
}

function sanitizeArtifactName(ref) {
  return String(ref == null ? "" : ref).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "gate";
}

// Build the injected integration-evidence reader (#947 D1/D2). An `integration:` gate's
// live evidence is an artifact FILE under the gate-evidence directory; the gate result
// derives from that artifact, NEVER from Orca task/worker status. A missing dir/file →
// { present: false } so the gate fails closed (never passed). This is the ONLY new
// filesystem read the gate modes perform, and it is strictly read-only.
function makeIntegrationEvidenceReader(dir) {
  const root = dir || (process.env.RELAY_ORCA_GATE_EVIDENCE_ROOT || "").trim() || null;
  return (ref) => {
    if (!root) return { present: false };
    const artifact = path.join(root, `${sanitizeArtifactName(ref)}.json`);
    if (!fs.existsSync(artifact)) return { present: false };
    try {
      const json = JSON.parse(fs.readFileSync(artifact, "utf-8"));
      return { present: true, passed: json.passed === true, evidence: typeof json.evidence === "string" ? json.evidence : `check ${ref}` };
    } catch (error) {
      // A corrupt artifact is unusable live evidence → not present → fail closed.
      return { present: false };
    }
  };
}

// D9.12 PINNED: proposals reach the receipt ONLY via `status --gates --record-proposals`.
// Without the flag, status writes NOTHING (byte-identity preserved). With it, the proposed
// follow-ups are UPSERTED into the receipt under `follow_ups` (additive; A-series atomic
// write) and the receipt's updated_at is bumped. Owner amendment A1: recording MUST NOT
// replace the existing `follow_ups` — an operator-set `deferred` row must survive. The
// upsert preserves recorded entries byte-for-byte (they win on id conflict) and appends
// only NEW derived ids, so re-recording never clobbers an operator's deferral.
function recordProposals(receipt, receiptPath, proposals) {
  receipt.follow_ups = upsertRecordedFollowUps({ recorded: receipt.follow_ups, derived: proposals });
  receipt.updated_at = new Date().toISOString();
  writeReceiptAtomic(receiptPath, serializeReceiptWithRecords(receipt));
}

// Apply the D7 fail-closed exit codes under --strict (precedence 70 > 71 > 72). Without
// --strict every situation exits 0 with the truthful report (information is the product).
function strictExitCode(opts, gateEval, programComplete) {
  if (!opts.strict) return 0;
  if (!gateEval.prerequisites_met) return GATE_REASONS.GATES_NOT_EVALUABLE;
  if (gateEval.gates.some((gate) => gate.state === "failed")) return GATE_REASONS.GATE_FAILED;
  if (opts.finalSummary && programComplete === false) return GATE_REASONS.COMPLETION_BLOCKED;
  return 0;
}

function runGatesMode(opts, { report, receipt, receiptPath }) {
  const { exitGates } = readProgramExitGates(opts.programFile, opts.programId);
  const gateEval = evaluateGates({ report, receipt, exitGates, readIntegrationEvidence: makeIntegrationEvidenceReader(opts.gateEvidenceDir) });
  const proposals = deriveProposals({ report, gates: gateEval.gates, receipt });
  if (opts.recordProposals && proposals.length > 0) recordProposals(receipt, receiptPath, proposals);
  const body = orderGatesReport({
    ok: true,
    program_id: opts.programId,
    receipt_path: receiptPath,
    prerequisites_met: gateEval.prerequisites_met,
    gates: gateEval.gates,
    follow_ups: proposals,
    blocking_reasons: gateEval.blocking_reasons,
  });
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  process.exitCode = strictExitCode(opts, gateEval, null);
}

function runFinalSummaryMode(opts, { report, receipt, receiptPath }) {
  const { exitGates } = readProgramExitGates(opts.programFile, opts.programId);
  const gateEval = evaluateGates({ report, receipt, exitGates, readIntegrationEvidence: makeIntegrationEvidenceReader(opts.gateEvidenceDir) });
  const derived = deriveProposals({ report, gates: gateEval.gates, receipt });
  const followUps = mergeFollowUps({ derived, recorded: receipt.follow_ups });
  const summary = buildFinalSummary({
    programId: opts.programId,
    receiptPath,
    report,
    gateEval,
    followUps,
    decisions: receipt.decisions,
  });
  const body = orderFinalSummary(summary);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  process.exitCode = strictExitCode(opts, gateEval, summary.program_complete);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) usageError("read-only live reconciler for an accepted program");
  if (!opts.programId) usageError("--program-id is required");

  let reconciliation;
  try {
    reconciliation = gatherReconciliation(opts);
  } catch (error) {
    // A24: a repo root that cannot be git-canonicalized fails closed with the same
    // RECEIPT_REPO_MISMATCH (exit 52) contract as a cross-repo receipt.
    if (error instanceof StatusError || error instanceof CanonicalizationError) failStatus(error, opts.json);
    throw error;
  }

  // #947 read-only status modes. Plain `status` (no mode flag) output stays BYTE-IDENTICAL
  // to the shipped #945/#946 shape.
  if (opts.gates) return void runGatesMode(opts, reconciliation);
  if (opts.finalSummary) return void runFinalSummaryMode(opts, reconciliation);

  printReport(reconciliation.report, opts.json);
  process.exitCode = 0;
}

// Run as a CLI only when invoked directly; importing this module (e.g. the A28 read-only
// boundary unit tests) exercises the guard functions without triggering a real status run.
if (require.main === module) main();

module.exports = { assertGhReadOnly, assertOrcaReadOnly, isMutatingGhApi };
