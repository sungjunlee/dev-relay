const path = require("path");
const { STATES, listManifestRecords, readManifest, validateRunId } = require("./relay-manifest");

const BRANCH_ONLY_TERMINAL_STATES = new Set([STATES.MERGED, STATES.CLOSED]);

function formatSelector({ runId, manifestPath, branch, prNumber }) {
  if (manifestPath) return `manifest '${manifestPath}'`;
  if (runId) return `run_id '${runId}'`;
  const parts = [];
  if (branch) parts.push(`branch '${branch}'`);
  if (prNumber !== undefined && prNumber !== null) parts.push(`pr '${prNumber}'`);
  return parts.join(" + ") || "selector";
}

function formatRunId(record) {
  return record?.data?.run_id || path.basename(record?.manifestPath || "unknown", ".md");
}

function formatCandidateRunIds(records) {
  return records.map((record) => formatRunId(record)).join(", ");
}

function formatCandidateDetails(records) {
  return records.map((record) => {
    const state = record?.data?.state || "unknown";
    const storedPr = hasStoredPrNumber(record) ? record.data.git.pr_number : "unset";
    return `${formatRunId(record)} (state=${state}, pr=${storedPr})`;
  }).join(", ");
}

function filterByBranch(records, branch, { excludeTerminal = false } = {}) {
  return records.filter((record) => {
    if (record?.data?.git?.working_branch !== branch) {
      return false;
    }
    // #149: branch-only resolution must ignore merged/closed runs; escalated stays eligible because
    // operators can recover by closing and re-dispatching (#163), so only true terminal states are excluded.
    if (excludeTerminal && BRANCH_ONLY_TERMINAL_STATES.has(record?.data?.state)) {
      return false;
    }
    return true;
  });
}

function filterByPr(records, prNumber) {
  return records.filter(({ data }) => Number(data?.git?.pr_number || 0) === Number(prNumber));
}

function hasStoredPrNumber(record) {
  return record?.data?.git?.pr_number !== undefined && record?.data?.git?.pr_number !== null;
}

function validateRequestedRunId(runId) {
  const validation = validateRunId(runId);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }
  return validation.runId;
}

function validateManifestRecordRunId(record) {
  const validation = validateRunId(record?.data?.run_id);
  if (!validation.valid) {
    throw new Error(
      `Relay manifest ${JSON.stringify(record?.manifestPath || "unknown")} has invalid run_id: ${validation.reason}`
    );
  }
  return record;
}

function buildNoManifestError(selector, { candidates = [], terminalOnly = false, recovery } = {}) {
  const parts = [`No relay manifest found for ${formatSelector(selector)}.`];
  if (candidates.length > 0) {
    parts.push(`Branch candidates: ${formatCandidateDetails(candidates)}.`);
  }
  if (terminalOnly) {
    parts.push("Only terminal branch matches exist; create a fresh dispatch for this branch before retrying.");
  }
  if (recovery) {
    parts.push(recovery);
  }
  return new Error(parts.join(" "));
}

function buildAmbiguousResolutionError(selector, matches) {
  return new Error(
    `Ambiguous relay manifest for ${formatSelector(selector)} (${matches.length} candidates): ` +
    `${formatCandidateRunIds(matches)}. Pass --manifest <path> or --run-id <id> explicitly. ` +
    "Close stale runs via close-run.js --run-id <id> before retrying if needed."
  );
}

function findManifestByRunId(repoRoot, runId) {
  const normalizedRunId = validateRequestedRunId(runId);
  const matches = listManifestRecords(repoRoot)
    .filter(({ data, manifestPath }) => (
      data?.run_id === normalizedRunId
      || path.basename(manifestPath, ".md") === normalizedRunId
    ));

  if (matches.length > 1) {
    throw new Error(`Ambiguous relay manifest for run_id '${normalizedRunId}'`);
  }
  return matches[0] ? validateManifestRecordRunId(matches[0]) : null;
}

function ensureUniqueRecord(matches, selector, options = {}) {
  if (matches.length === 0) {
    throw buildNoManifestError(selector, options);
  }
  if (matches.length > 1) {
    throw buildAmbiguousResolutionError(selector, matches);
  }
  return matches[0];
}

function resolveManifestRecord({
  repoRoot,
  manifestPath,
  runId,
  branch,
  prNumber,
}) {
  if (manifestPath) {
    const resolved = path.resolve(manifestPath);
    return validateManifestRecordRunId({ manifestPath: resolved, ...readManifest(resolved) });
  }

  if (runId) {
    const match = findManifestByRunId(repoRoot, runId);
    if (!match) {
      throw new Error(`No relay manifest found for run_id '${runId}'`);
    }
    return match;
  }

  if (!branch && (prNumber === undefined || prNumber === null)) {
    throw new Error("Provide --run-id, --manifest, --branch, or --pr");
  }

  const allRecords = listManifestRecords(repoRoot);
  let matches = allRecords;
  if (branch && prNumber !== undefined && prNumber !== null) {
    const branchMatches = filterByBranch(allRecords, branch);
    const nonTerminalBranchMatches = filterByBranch(allRecords, branch, { excludeTerminal: true });
    matches = filterByPr(branchMatches, prNumber);
    if (matches.length === 0) {
      if (nonTerminalBranchMatches.length === 1 && !hasStoredPrNumber(nonTerminalBranchMatches[0])) {
        matches = nonTerminalBranchMatches;
      } else if (nonTerminalBranchMatches.length > 1) {
        throw buildAmbiguousResolutionError({ branch, prNumber }, nonTerminalBranchMatches);
      }
    }
  } else if (branch) {
    const branchMatches = filterByBranch(allRecords, branch);
    matches = filterByBranch(allRecords, branch, { excludeTerminal: true });
    return validateManifestRecordRunId(ensureUniqueRecord(matches, { branch }, {
      candidates: branchMatches.length > 0 ? branchMatches : [],
      terminalOnly: branchMatches.length > 0 && matches.length === 0,
      recovery: branchMatches.length > 0 && matches.length === 0
        ? "Pass --run-id <id> or --manifest <path> explicitly if you meant an existing active run."
        : undefined,
    }));
  } else if (prNumber !== undefined && prNumber !== null) {
    matches = filterByPr(allRecords, prNumber);
  }

  if (branch && prNumber !== undefined && prNumber !== null && matches.length === 0) {
    const branchMatches = filterByBranch(allRecords, branch);
    const nonTerminalBranchMatches = filterByBranch(allRecords, branch, { excludeTerminal: true });
    return validateManifestRecordRunId(ensureUniqueRecord(matches, { branch, prNumber }, {
      candidates: branchMatches.length > 0 ? branchMatches : [],
      terminalOnly: branchMatches.length > 0 && nonTerminalBranchMatches.length === 0,
      recovery: branchMatches.length > 0 && nonTerminalBranchMatches.length === 0
        ? "Create a fresh dispatch for this branch before retrying."
        : "Pass --run-id <id> or --manifest <path> explicitly if you meant an existing run.",
    }));
  }

  return validateManifestRecordRunId(ensureUniqueRecord(matches, { branch, prNumber }));
}

module.exports = {
  filterByBranch,
  filterByPr,
  findManifestByRunId,
  hasStoredPrNumber,
  resolveManifestRecord,
};
