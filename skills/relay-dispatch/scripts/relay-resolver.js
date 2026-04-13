// ---------------------------------------------------------------------------
// Resolver selector x CALL-SITE audit table (#174)
// Call-site extension meta-rule: when fixing one selector call site, audit every
// other call site of that selector in the same PR (iteration-4 scope-boundary trap
// note, memory/feedback_rubric_fail_closed.md; closes the #149 -> #165 -> #168 -> #170 ladder).
//
// | Selector                 | Call site (line)                                 | State-awareness verdict               | Closed by |
// | ------------------------ | ------------------------------------------------ | ------------------------------------- | --------- |
// | filterByBranch           | filterByBranchPrFallback:105                     | state-aware via excludeTerminal=true  | #149      |
// | filterByBranch           | resolveManifestRecord:328 branchMatches          | state-blind by purpose (error pool)   | #174      |
// | filterByBranch           | resolveManifestRecord:329 nonTerminal            | state-aware via excludeTerminal=true  | #149      |
// | filterByBranch           | resolveManifestRecord:359 branchMatches          | state-blind by purpose (error pool)   | #149      |
// | filterByBranch           | resolveManifestRecord:360 branch-only            | state-aware via excludeTerminal=true  | #149      |
// | filterByBranch           | resolveManifestRecord:375 branchMatches          | state-blind by purpose (error pool)   | #174      |
// | filterByBranch           | resolveManifestRecord:377 nonTerminal retry      | state-aware via excludeTerminal=true  | #149      |
// | filterByPr               | resolveManifestRecord:338 branch+PR nonTerminal  | state-aware via composed subset       | #170      |
// | filterByPr               | resolveManifestRecord:371 standalone --pr        | state-aware via filterOutTerminal     | #174      |
// | filterByPr               | resolveManifestRecord:381 retry terminal-only    | state-aware by purpose (mixed-state)  | #174      |
// | filterByBranchPrFallback | resolveManifestRecord:330 branch+PR fallback     | dispatched-only whitelist             | #168      |
// | filterByBranchPrFallback | resolveManifestRecord:376 retry fallback         | dispatched-only whitelist             | #168      |
// | findManifestByRunId      | resolveManifestRecord:314 explicit --run-id      | state-blind by design                 | n/a       |
// ---------------------------------------------------------------------------

const path = require("path");
const { STATES, listManifestRecords, readManifest, validateRunId, validateTransition } = require("./relay-manifest");

const BRANCH_ONLY_TERMINAL_STATES = new Set([STATES.MERGED, STATES.CLOSED]);
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
  // Raw stored run_id stays available for happy-path rendering and validated explicit selectors.
  // Error builders must use safeFormatRunId so tampered manifests cannot echo unsafe values (#171/#174).
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

function isKnownState(state) {
  return KNOWN_STATES.has(state);
}

function isTerminalState(state) {
  return BRANCH_ONLY_TERMINAL_STATES.has(state);
}

function filterOutTerminal(records) {
  return records.filter((record) => !isTerminalState(record?.data?.state));
}

function filterByBranch(records, branch, { excludeTerminal = false } = {}) {
  // [state-aware] via excludeTerminal opt-in (#149). Callers must opt in for
  // stale-inheritance-sensitive paths; standalone branch-only resolution does.
  // Selector-composition audit table at top of file.
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
  // [state-aware] only when callers compose it with the correct subset. #174 extends
  // the selector-composition audit rule to CALL SITES, so every filterByPr call site
  // in this file is enumerated in the top audit table.
  return records.filter(({ data }) => Number(data?.git?.pr_number || 0) === Number(prNumber));
}

function filterByBranchPrFallback(records, branch) {
  // [state-aware whitelist] dispatched + null only (#168). Treat the state axis as a
  // whitelist, not a blacklist — see memory/feedback_rubric_fail_closed.md.
  return filterByBranch(records, branch, { excludeTerminal: true })
    .filter((record) => {
      // #168: treat the state-machine axis as a whitelist, not a blacklist. Fixing only the state named
      // in the latest bug is compliance theater; the only legitimate null-pr fallback is DISPATCHED.
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
  return !isTerminalState(record?.data?.state)
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
  // #168: a single non-terminal branch match whose state is NOT on the branch-fallback whitelist
  // (anything except DISPATCHED) with no stored pr_number is stale-inheritance-eligible under the
  // pre-#168 predicate. Treat every such state the same way so recovery messaging is uniform
  // across escalated / review_pending / changes_requested / ready_to_merge. Generalizes the prior
  // escalated-only helper per the state-machine-axis whitelist meta-rule from
  // memory/feedback_rubric_fail_closed.md.
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
  // #174 reachability audit: close-run is only suggested when validateTransition(state, CLOSED)
  // succeeds. Terminal and invalid states get command-free recovery text instead.
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
  // #174 reachability audit: this builder only emits commandless terminal-only/fresh-dispatch text
  // plus caller-supplied recovery that must already be state-validated by the caller.
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
  // #174 reachability audit: the only operator actions named here are explicit selectors, which remain
  // valid for every ambiguous candidate set. Mixed terminal/non-terminal recovery uses its own builder.
  return new Error(
    `Ambiguous relay manifest for ${formatSelector(selector)} (${matches.length} candidates): ` +
    `${formatCandidateDetails(matches)}. Pass --manifest <path> or --run-id <id> explicitly.`
  );
}

function buildMixedStateRecoveryMessage(repoRoot, { terminalCandidate, freshCandidate }) {
  // #174 reachability audit: the terminal sibling is already terminal and the fresh sibling cannot
  // advance via same-run resume here, so the only documented recovery is a fresh dispatch.
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
  // [state-blind by design] explicit selectors must resolve EVERY state to keep
  // operator recovery reachable (#149/#165/#157/#163).
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
    const branchFallbackMatches = filterByBranchPrFallback(allRecords, branch);
    // #170: compose filterByPr with nonTerminalBranchMatches so stale merged/closed
    // manifests with stored pr_number === prNumber cannot shadow a fresh dispatched+null run.
    // Selector-composition axis enumeration meta-rule (memory/feedback_rubric_fail_closed.md):
    // the state-machine axis is a property of EVERY resolver selector; #149 closed it for
    // filterByBranch, #168 closed it for filterByBranchPrFallback, this commit closes it for
    // filterByPr at this composition site. branchMatches stays bound for the preserved
    // candidates list passed into the no-match error.
    matches = filterByPr(nonTerminalBranchMatches, prNumber);
    if (matches.length === 0) {
      // #174 end-to-end recovery audit: when a mixed terminal/non-terminal collision tells the
      // operator to create a fresh DISPATCHED run, the next lookup must let that single fallback
      // win over stale null-pr siblings instead of re-opening the ambiguity ladder.
      if (shouldPreferSingleBranchFallback({
        branchMatches,
        nonTerminalBranchMatches,
        branchFallbackMatches,
        prNumber,
      })) {
        matches = branchFallbackMatches;
      }
      if (matches.length === 0 && nonTerminalBranchMatches.length > 1) {
        throw buildAmbiguousResolutionError({ branch, prNumber }, nonTerminalBranchMatches);
      }
      if (matches.length === 0 && branchFallbackMatches.length === 1) {
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
    // #174 / call-site extension meta-rule: standalone --pr must also exclude merged/closed
    // siblings, not just the branch+PR composition path.
    matches = filterByPr(filterOutTerminal(allRecords), prNumber);
  }

  if (branch && prNumber !== undefined && prNumber !== null && matches.length === 0) {
    const branchMatches = filterByBranch(allRecords, branch);
    const branchFallbackMatches = filterByBranchPrFallback(allRecords, branch);
    const nonTerminalBranchMatches = filterByBranch(allRecords, branch, { excludeTerminal: true });
    // #174: this retry path deliberately asks a DIFFERENT question than the exact-PR resolver above.
    // Feed filterByPr a terminal-only subset here so the mixed-state detector can distinguish
    // "stale terminal stored the caller PR" from ordinary non-terminal ambiguity.
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
      recovery: staleFallbackRecord
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
};
