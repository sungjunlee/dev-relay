// Resolver invariants: state exclusions fail closed via KNOWN_NON_TERMINAL_STATES,
// selector composition stays audited across the branch/pr call-site axis, and
// null-pr fallback stays a dispatched-only state-machine whitelist.
// Full selector audit history and issue/meta-rule ledger:
// docs/relay-resolver-audit-history.md

const path = require("path");
const { STATES, validateTransition } = require("./manifest/lifecycle");
const { listManifestRecords, readManifest } = require("./manifest/store");
const { validateRunId } = require("./manifest/paths");

const BRANCH_ONLY_TERMINAL_STATES = new Set([STATES.MERGED, STATES.CLOSED]);
const KNOWN_NON_TERMINAL_STATES = new Set(
  Object.values(STATES).filter((state) => BRANCH_ONLY_TERMINAL_STATES.has(state) === false)
);
const KNOWN_STATES = new Set(Object.values(STATES));

function formatSelector({ runId, manifestPath, branch, prNumber }) {
  if (manifestPath) return `manifest '${manifestPath}'`;
  if (runId) return `run_id '${runId}'`;
  const parts = [];
  if (branch) parts.push(`branch '${branch}'`);
  if (prNumber !== undefined && prNumber !== null) parts.push(`pr '${prNumber}'`);
  return parts.join(" + ") || "selector";
}

function formatManifestBasename(record) {
  return path.basename(record?.manifestPath || "unknown", ".md");
}

function formatRunId(record) {
  // Happy-path rendering may use the stored run_id; error builders must use safeFormatRunId.
  return record?.data?.run_id || formatManifestBasename(record);
}

function safeFormatRunId(record) {
  const validation = validateRunId(record?.data?.run_id);
  return validation.valid ? validation.runId : formatManifestBasename(record);
}

function formatCandidateRunIds(records) {
  return records.map((record) => formatRunId(record)).join(", ");
}

function formatCandidateDetails(records) {
  return records.map((record) => {
    const state = record?.data?.state || "unknown";
    const storedPr = hasStoredPrNumber(record) ? record.data.git.pr_number : "unset";
    return `${safeFormatRunId(record)} (state=${state}, pr=${storedPr})`;
  }).join(", ");
}

function getSelectorCandidateLabel(selector) {
  return selector?.prNumber !== undefined && selector?.prNumber !== null && !selector?.branch
    ? "PR"
    : "Branch";
}

function isKnownState(state) {
  return KNOWN_STATES.has(state);
}

function isTerminalState(state) {
  return BRANCH_ONLY_TERMINAL_STATES.has(state);
}

function isNonTerminalState(state) {
  return KNOWN_NON_TERMINAL_STATES.has(state);
}

function findInvalidStateRecord(records) {
  return records.find((record) => !isKnownState(record?.data?.state)) || null;
}

function filterOutTerminal(records) {
  // Fail-closed: exclude-by-state sites admit only KNOWN_NON_TERMINAL_STATES.
  return records.filter((record) => isNonTerminalState(record?.data?.state));
}

function filterByBranch(records, branch, { excludeTerminal = false } = {}) {
  // Branch matching stays state-blind unless callers opt into fail-closed terminal exclusion.
  return records.filter((record) => {
    if (record?.data?.git?.working_branch !== branch) {
      return false;
    }
    if (excludeTerminal && !isNonTerminalState(record?.data?.state)) {
      return false;
    }
    return true;
  });
}

function filterByPr(records, prNumber) {
  // PR matching is state-blind; callers compose it with the subset that matches their invariant.
  return records.filter(({ data }) => Number(data?.git?.pr_number || 0) === Number(prNumber));
}

function filterByBranchPrFallback(records, branch) {
  // Fail-closed: branch fallback is limited to dispatched records that do not yet store a PR.
  return filterByBranch(records, branch, { excludeTerminal: true })
    .filter((record) => {
      return record?.data?.state === STATES.DISPATCHED && !hasStoredPrNumber(record);
    });
}

function hasStoredPrNumber(record) {
  return record?.data?.git?.pr_number !== undefined && record?.data?.git?.pr_number !== null;
}

function hasTerminalExactPrSibling(records, prNumber) {
  return records.some((record) => (
    isTerminalState(record?.data?.state)
    && Number(record?.data?.git?.pr_number || 0) === Number(prNumber)
  ));
}

function isStaleNullPrSibling(record) {
  // Defense-in-depth: stale null-pr sibling classification stays fail-closed on unknown states.
  return isNonTerminalState(record?.data?.state)
    && record?.data?.state !== STATES.DISPATCHED
    && !hasStoredPrNumber(record);
}

function shouldPreferSingleBranchFallback({ branchMatches, nonTerminalBranchMatches, branchFallbackMatches, prNumber }) {
  if (branchFallbackMatches.length !== 1) {
    return false;
  }
  if (nonTerminalBranchMatches.length === 1) {
    return true;
  }
  if (!hasTerminalExactPrSibling(branchMatches, prNumber)) {
    return false;
  }
  const [fallbackRecord] = branchFallbackMatches;
  return nonTerminalBranchMatches
    .filter((record) => record?.manifestPath !== fallbackRecord?.manifestPath)
    .every(isStaleNullPrSibling);
}

function findStaleNonTerminalBranchFallbackCandidate(records) {
  // Recovery text treats every single stale non-terminal null-pr sibling the same way.
  if (records.length !== 1) {
    return null;
  }
  const [record] = records;
  if (record?.data?.state === STATES.DISPATCHED || hasStoredPrNumber(record)) {
    return null;
  }
  return record;
}

function buildCloseRunCommand(repoRoot, runId, reason) {
  return `node skills/relay-dispatch/scripts/close-run.js --repo ${JSON.stringify(repoRoot)} ` +
    `--run-id ${JSON.stringify(runId)} --reason ${JSON.stringify(reason)}`;
}

function formatQuotedValue(value) {
  return `'${String(value ?? "unknown")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}'`;
}

function canTransitionToClosed(state) {
  if (!isKnownState(state)) {
    return false;
  }
  try {
    validateTransition(state, STATES.CLOSED);
    return true;
  } catch {
    return false;
  }
}

function buildStaleBranchFallbackRecoveryMessage(repoRoot, record) {
  // Recovery text only suggests close-run when the record can transition to CLOSED.
  const runId = safeFormatRunId(record);
  const state = record?.data?.state || "unknown";
  const manifestPath = record?.manifestPath || "unknown";
  const branch = record?.data?.git?.working_branch || "unknown";
  if (!isKnownState(state)) {
    return `Manifest at ${JSON.stringify(manifestPath)} has invalid state ${formatQuotedValue(state)}; ` +
      "manually inspect and correct the state field, or remove the run directory.";
  }
  if (isTerminalState(state)) {
    return `Run ${JSON.stringify(runId)} is already ${state}; close-run is a no-op for terminal manifests. ` +
      `Create a fresh dispatch for branch '${branch}' before retrying.`;
  }
  if (!canTransitionToClosed(state)) {
    return `Run ${JSON.stringify(runId)} is in state ${state} and cannot be auto-closed here; ` +
      `inspect it explicitly via --run-id ${JSON.stringify(runId)}.`;
  }
  return `Close the stale ${state} run via ${buildCloseRunCommand(repoRoot, runId, `stale_${state}_run`)} ` +
    `before retrying, or inspect it explicitly via --run-id ${JSON.stringify(runId)}.`;
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
  // No-match errors keep recovery limited to explicit selectors, fresh dispatch, or validated caller text.
  const parts = [`No relay manifest found for ${formatSelector(selector)}.`];
  const candidateLabel = getSelectorCandidateLabel(selector);
  if (candidates.length > 0) {
    parts.push(`${candidateLabel} candidates: ${formatCandidateDetails(candidates)}.`);
  }
  if (terminalOnly) {
    parts.push(
      candidateLabel === "PR"
        ? "Only terminal PR matches exist; create a fresh dispatch that records this PR before retrying, or pass --run-id <id> or --manifest <path> to target an existing terminal run explicitly."
        : "Only terminal branch matches exist; create a fresh dispatch for this branch before retrying."
    );
  }
  if (recovery) {
    parts.push(recovery);
  }
  return new Error(parts.join(" "));
}

function buildAmbiguousResolutionError(selector, matches) {
  // Ambiguity errors name only explicit selectors that stay valid for every candidate set.
  return new Error(
    `Ambiguous relay manifest for ${formatSelector(selector)} (${matches.length} candidates): ` +
    `${formatCandidateDetails(matches)}. Pass --manifest <path> or --run-id <id> explicitly.`
  );
}

function buildMixedStateRecoveryMessage(repoRoot, { terminalCandidate, freshCandidate }) {
  // Mixed terminal/non-terminal PR reuse always recovers via fresh dispatch, not same-run resume.
  const branch = freshCandidate?.data?.git?.working_branch
    || terminalCandidate?.data?.git?.working_branch
    || "unknown";
  const terminalState = terminalCandidate?.data?.state || "unknown";
  const freshState = freshCandidate?.data?.state || "unknown";
  const terminalStoredPr = hasStoredPrNumber(terminalCandidate)
    ? terminalCandidate.data.git.pr_number
    : "unset";
  return new Error(
    `Mixed relay manifest reuse detected on branch '${branch}' for stored PR '${terminalStoredPr}': ` +
    `${formatCandidateDetails([terminalCandidate, freshCandidate])}. ` +
    `The terminal sibling ${JSON.stringify(safeFormatRunId(terminalCandidate))} is already ${terminalState}, ` +
    "so close-run is a no-op for it. " +
    `The ${freshState} sibling ${JSON.stringify(safeFormatRunId(freshCandidate))} does not carry the caller PR. ` +
    `Create a fresh dispatch for branch '${branch}' before retrying.`
  );
}

function findManifestByRunId(repoRoot, runId) {
  // Explicit run-id selection stays state-blind so operators can target any manifest directly.
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
  includeTerminal = false,
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
    const branchFallbackMatches = filterByBranchPrFallback(allRecords, branch);
    const invalidBranchStateRecord = findInvalidStateRecord(branchMatches);
    // Exact-PR resolution must compose against the fail-closed non-terminal branch subset.
    matches = filterByPr(nonTerminalBranchMatches, prNumber);
    if (matches.length === 0) {
      if (shouldPreferSingleBranchFallback({
        branchMatches,
        nonTerminalBranchMatches,
        branchFallbackMatches,
        prNumber,
      }) && !invalidBranchStateRecord) {
        matches = branchFallbackMatches;
      }
      if (matches.length === 0 && nonTerminalBranchMatches.length > 1) {
        throw buildAmbiguousResolutionError({ branch, prNumber }, nonTerminalBranchMatches);
      }
      if (matches.length === 0 && !invalidBranchStateRecord && branchFallbackMatches.length === 1) {
        matches = branchFallbackMatches;
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
    const prCandidates = filterByPr(
      allRecords,
      prNumber
    );
    const invalidPrCandidate = findInvalidStateRecord(prCandidates);
    if (includeTerminal) {
      matches = filterByPr(allRecords, prNumber);
    } else {
      // Standalone --pr stays fail-closed unless the caller opts into terminal inclusion.
      matches = filterByPr(filterOutTerminal(allRecords), prNumber);
      if (matches.length === 0 && prCandidates.length > 0) {
        throw buildNoManifestError({ prNumber }, {
          candidates: prCandidates,
          terminalOnly: !invalidPrCandidate,
          recovery: invalidPrCandidate
            ? buildStaleBranchFallbackRecoveryMessage(repoRoot, invalidPrCandidate)
            : undefined,
        });
      }
    }
  }

  if (branch && prNumber !== undefined && prNumber !== null && matches.length === 0) {
    const branchMatches = filterByBranch(allRecords, branch);
    const branchFallbackMatches = filterByBranchPrFallback(allRecords, branch);
    const nonTerminalBranchMatches = filterByBranch(allRecords, branch, { excludeTerminal: true });
    const invalidBranchStateRecord = findInvalidStateRecord(branchMatches);
    // Detection-only: mixed-state retry intentionally asks for known terminal siblings.
    const terminalExactPrMatches = filterByPr(
      branchMatches.filter((record) => BRANCH_ONLY_TERMINAL_STATES.has(record?.data?.state)),
      prNumber
    );
    if (
      terminalExactPrMatches.length > 0
      && branchFallbackMatches.length === 0
      && nonTerminalBranchMatches.length === 1
      && nonTerminalBranchMatches[0]?.data?.state === STATES.REVIEW_PENDING
    ) {
      throw buildMixedStateRecoveryMessage(repoRoot, {
        terminalCandidate: terminalExactPrMatches[0],
        freshCandidate: nonTerminalBranchMatches[0],
      });
    }
    const staleFallbackRecord = findStaleNonTerminalBranchFallbackCandidate(nonTerminalBranchMatches);
    return validateManifestRecordRunId(ensureUniqueRecord(matches, { branch, prNumber }, {
      candidates: branchMatches.length > 0 ? branchMatches : [],
      terminalOnly: branchMatches.length > 0 && nonTerminalBranchMatches.length === 0,
      recovery: invalidBranchStateRecord
        ? buildStaleBranchFallbackRecoveryMessage(repoRoot, invalidBranchStateRecord)
        : staleFallbackRecord
        ? buildStaleBranchFallbackRecoveryMessage(repoRoot, staleFallbackRecord)
        : branchMatches.length > 0 && nonTerminalBranchMatches.length === 0
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
  safeFormatRunId,
};
