const path = require("path");
const { listManifestRecords, readManifest, validateRunId } = require("./relay-manifest");

function formatSelector({ runId, manifestPath, branch, prNumber }) {
  if (manifestPath) return `manifest '${manifestPath}'`;
  if (runId) return `run_id '${runId}'`;
  const parts = [];
  if (branch) parts.push(`branch '${branch}'`);
  if (prNumber !== undefined && prNumber !== null) parts.push(`pr '${prNumber}'`);
  return parts.join(" + ") || "selector";
}

function filterByBranch(records, branch) {
  return records.filter(({ data }) => data?.git?.working_branch === branch);
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

function ensureUniqueRecord(matches, selector) {
  if (matches.length === 0) {
    throw new Error(`No relay manifest found for ${formatSelector(selector)}`);
  }
  if (matches.length > 1) {
    const details = matches
      .map(({ data }) => data?.run_id || "unknown")
      .join(", ");
    throw new Error(`Ambiguous relay manifest for ${formatSelector(selector)}: ${details}`);
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
    matches = filterByPr(filterByBranch(allRecords, branch), prNumber);
    if (matches.length === 0) {
      const branchMatches = filterByBranch(allRecords, branch);
      if (branchMatches.length === 1 && !hasStoredPrNumber(branchMatches[0])) {
        matches = branchMatches;
      }
    }
  } else if (branch) {
    matches = filterByBranch(allRecords, branch);
  } else if (prNumber !== undefined && prNumber !== null) {
    matches = filterByPr(allRecords, prNumber);
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
