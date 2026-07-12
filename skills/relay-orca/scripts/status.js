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
  resolveRepoContext,
  receiptPathFor,
  readReceiptFile,
  receiptExists,
  listManifestFiles,
  makeUrlResolver,
} = require("./receipt-io");
const { resolveOrcaBin } = require("./lib/resolve-orca-bin");
const { parseReceipt } = require("./lib/receipt");
const { boundedExcerpt } = require("./lib/bounded-excerpt");
const { parseManifest } = require("./lib/manifest-parse");
const { deriveStatusReport } = require("./lib/status-derive");
const { StatusError, USAGE_EXIT, reject } = require("./lib/status-reasons");

const READ_TIMEOUT_MS = 15000;
const READ_MAX_BUFFER = 4 * 1024 * 1024;

function usageError(message) {
  process.stderr.write(`relay-orca status: ${message}\n`);
  process.stderr.write(
    "usage: status.js --program-id <id> [--json] [--orca-bin <path>] [--gh-bin <path>] [--repo-root <path>]\n",
  );
  process.exit(USAGE_EXIT);
}

function requireValue(value, flag) {
  if (!value || value.startsWith("-")) usageError(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = { programId: null, json: false, orcaBin: null, ghBin: null, repoRoot: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--program-id" || arg === "-p") opts.programId = requireValue(argv[(i += 1)], "--program-id");
    else if (arg === "--json") opts.json = true;
    else if (arg === "--orca-bin") opts.orcaBin = requireValue(argv[(i += 1)], "--orca-bin");
    else if (arg === "--gh-bin") opts.ghBin = requireValue(argv[(i += 1)], "--gh-bin");
    else if (arg === "--repo-root") opts.repoRoot = requireValue(argv[(i += 1)], "--repo-root");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else usageError(`unrecognized argument: ${arg}`);
  }
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

// Structural read-only refusal for gh: only `issue view`, `pr view`, and read-shaped
// `api` GETs are permitted (D3). Any write subcommand is refused before it runs.
function assertGhReadOnly(argv) {
  const isIssueView = argv[0] === "issue" && argv[1] === "view";
  const isPrView = argv[0] === "pr" && argv[1] === "view";
  const isApiRead = argv[0] === "api" && !argv.some((token) => /^(-X|--method)$/.test(token))
    && !argv.some((token) => /^(POST|PATCH|PUT|DELETE)$/i.test(token));
  if (!isIssueView && !isPrView && !isApiRead) {
    throw new Error(`relay-orca status must never invoke a non-read gh subcommand (got: ${argv.join(" ")})`);
  }
}

function makeRunner(bin, assertReadOnly) {
  if (!bin) return null;
  return (_bin, args) => {
    const argv = (Array.isArray(args) ? args : []).map(String);
    assertReadOnly(argv);
    try {
      const stdout = execFileSync(bin, argv, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) usageError("read-only live reconciler for an accepted program");
  if (!opts.programId) usageError("--program-id is required");

  let report;
  try {
    const repo = resolveRepoContext({ repoRootOverride: opts.repoRoot });
    const receiptPath = receiptPathFor(repo.slug, opts.programId);
    const receipt = loadReceipt(receiptPath, opts.programId);
    if (receipt.repo && receipt.repo.slug !== repo.slug) {
      reject("RECEIPT_REPO_MISMATCH", `receipt repo.slug ${receipt.repo.slug} does not match the current repo slug ${repo.slug}`);
    }
    const manifests = listManifestFiles(repo.slug).map((entry) => ({
      run_id: entry.run_id,
      text: entry.text,
      parsed: parseManifest(entry.text),
    }));
    report = deriveStatusReport({
      receipt,
      programId: opts.programId,
      receiptPath,
      manifests,
      orca: makeRunner(resolveOrca(opts), assertOrcaReadOnly),
      gh: makeRunner(resolveGhBin(opts), assertGhReadOnly),
      urlFor: makeUrlResolver(repo.root),
    });
  } catch (error) {
    if (error instanceof StatusError) failStatus(error, opts.json);
    throw error;
  }

  printReport(report, opts.json);
  process.exitCode = 0;
}

main();
