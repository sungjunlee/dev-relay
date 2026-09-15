"use strict";

// Native forge change-request seam (#1210).
//
// Concrete consumer: recover.js observeGithub / selectGithubPr /
// exactPublishedPr. That observer is not rewritten, so retained GitHub
// facts and decisions stay byte-compatible. The GitLab adapter is the
// second native implementation of the same observation + exact-head bind.
//
// Seam members (no unused extension points):
//
//   provider
//   classifyRemote(remoteUrl)                -> { provider, project, ... } | null
//   observeChangeRequest(input)              -> provider-specific observation facts
//   exactPublishedChangeRequest(observation, -> boolean binding review/landing
//     { branch }, headSha)                      to the exact live change-request head
//
// Phase separation is preserved: an adapter only observes the forge-owned
// Change Request identity. Publication stays with canonical recovery, review
// stays with relay-review, authorization and Landing stay with explicit
// relay-merge. The core Git ReviewSubject is unchanged; GitLab merge-request
// identity and the exact live head SHA are mapped into provider-specific
// facts (mr_*) and never into core lifecycle records.
//
// See references/forge-change-request-adapters.md for the documented contract.

const { execFileSync } = require("child_process");

function commandFailureLine(error) {
  return String(error?.stderr || error?.stdout || error?.message || error).trim().split(/\r?\n/)[0];
}

// ---------------------------------------------------------------------------
// GitHub adapter — decision-compatible with the retained production observer
// (recover.js observeGithub / selectGithubPr / exactPublishedPr). The
// selection decision is imported from its definition site so the seam and the
// retained route cannot drift.
// ---------------------------------------------------------------------------

const GITHUB_PR_JSON_FIELDS = "number,state,url,headRefName,headRefOid,baseRefName,baseRefOid,headRepository,headRepositoryOwner,isCrossRepository,mergedAt,mergeCommit,body";

function classifyGithubRemote(remoteUrl) {
  const remote = String(remoteUrl || "").trim().replace(/\/$/, "");
  const match = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i)
    || remote.match(/^(?:ssh:\/\/git@|https?:\/\/)github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (match) return { provider: "github", project: match[1].replace(/\.git$/i, "").toLowerCase() };
  if (/^[^/:]+\/[^/]+$/.test(remote)) return { provider: "github", project: remote.replace(/\.git$/i, "").toLowerCase() };
  return null;
}

function observeGithubChangeRequest({ project, repoRoot = null, branch, baseBranch, localHeadSha = null, recordedCrNumber = null }) {
  // Deferred require: classification stays lightweight and no module-level
  // coupling is added to the retained recovery runtime.
  const { execGh } = require("./exec");
  const { selectGithubPr } = require("./recover").__testing;
  try {
    const rows = JSON.parse(execGh(repoRoot, [
      "pr", "list", "--repo", project, "--head", branch, "--state", "all", "--limit", "100",
      "--json", GITHUB_PR_JSON_FIELDS,
    ], { timeout: 15_000 }));
    const selection = selectGithubPr(rows, {
      remote: project, branch, baseBranch, localHeadSha, recordedPrNumber: recordedCrNumber,
    });
    const pr = selection.pr;
    return {
      available: true,
      lookup_complete: true,
      pr_lookup_complete: true,
      matching_pr_count: selection.matchingPrCount, identity_match_count: selection.identityMatchCount,
      open_pr_count: selection.openPrCount, merged_pr_count: selection.mergedPrCount,
      closed_pr_count: selection.closedPrCount,
      repo: project,
      pr_number: pr?.number || null, pr_state: pr?.state || null,
      head_ref: pr?.headRefName || branch, base_ref: pr?.baseRefName || baseBranch,
      head_repo: pr ? selection.headRepo(pr) : project,
      pr_head_sha: pr?.headRefOid || null, pr_base_sha: pr?.baseRefOid || null,
      merge_sha: pr?.mergeCommit?.oid || null,
      url: pr?.url || null, body: pr?.body || null,
    };
  } catch (error) {
    return {
      available: false, lookup_complete: false, pr_lookup_complete: false, matching_pr_count: null,
      repo: project,
      pr_number: null, pr_state: null, head_ref: branch, base_ref: baseBranch,
      pr_head_sha: null, pr_base_sha: null, merge_sha: null,
      error: { code: "GITHUB_OBSERVATION_FAILED", message: commandFailureLine(error), retryable: true },
    };
  }
}

const githubChangeRequestAdapter = {
  provider: "github",
  classifyRemote: classifyGithubRemote,
  observeChangeRequest: observeGithubChangeRequest,
  // Mirrors recover.js exactPublishedPr exactly for equivalent facts.
  exactPublishedChangeRequest(observation, { branch }, headSha) {
    return observation?.available === true
      && observation.matching_pr_count === 1
      && Number.isInteger(observation.pr_number)
      && observation.head_ref === branch
      && observation.pr_head_sha === headSha;
  },
};

// ---------------------------------------------------------------------------
// GitLab adapter — native merge-request observation through the GitLab REST
// API. Credentials: GITLAB_TOKEN / GITLAB_API_TOKEN, or `glab auth token`
// (RELAY_GLAB_BIN override). Self-managed hosts: RELAY_GITLAB_HOSTS
// (comma-separated). API base override: GITLAB_API_URL.
// ---------------------------------------------------------------------------

function gitlabHosts() {
  const extra = String(process.env.RELAY_GITLAB_HOSTS || "")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  return ["gitlab.com", ...extra.filter((host) => host !== "gitlab.com")];
}

function escapeHostRegExp(host) {
  return host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyGitlabRemote(remoteUrl) {
  const remote = String(remoteUrl || "").trim().replace(/\/$/, "");
  for (const host of gitlabHosts()) {
    const escaped = escapeHostRegExp(host);
    const match = remote.match(new RegExp(`^git@${escaped}:(.+?)(?:\\.git)?$`, "i"))
      || remote.match(new RegExp(`^ssh:\/\/git@${escaped}(?::\\d+)?\/(.+?)(?:\\.git)?$`, "i"))
      || remote.match(new RegExp(`^https?:\/\/(?:[^/@]+@)?${escaped}\/(.+?)(?:\\.git)?$`, "i"));
    if (!match) continue;
    const project = match[1].replace(/\.git$/i, "").toLowerCase();
    // A GitLab project path always has at least a namespace and a name.
    if (project.split("/").filter(Boolean).length < 2) continue;
    return { provider: "gitlab", project, host };
  }
  return null;
}

function resolveGitlabToken() {
  const direct = String(process.env.GITLAB_TOKEN || process.env.GITLAB_API_TOKEN || "").trim();
  if (direct) return direct;
  try {
    const glabBin = process.env.RELAY_GLAB_BIN || "glab";
    const token = String(execFileSync(glabBin, ["auth", "token"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    })).trim();
    if (token) return token;
  } catch {}
  return null;
}

function gitlabApiBase(host) {
  return String(process.env.GITLAB_API_URL || "").trim().replace(/\/+$/, "") || `https://${host}/api/v4`;
}

async function fetchTransport({ url, headers }) {
  const response = await fetch(url, { method: "GET", headers });
  const body = await response.text();
  return { status: response.status, body };
}

function gitlabRequestError(status) {
  if (status === 401) return { code: "GITLAB_AUTH_INVALID", message: `GitLab rejected the token (HTTP ${status})`, retryable: false };
  if (status === 403) return { code: "GITLAB_PERMISSION_DENIED", message: `GitLab denied access to the project or merge requests (HTTP ${status})`, retryable: false };
  if (status === 404) return { code: "GITLAB_NOT_FOUND", message: `GitLab project or merge-request endpoint not found (HTTP ${status})`, retryable: false };
  if (status === 429 || status >= 500) return { code: "GITLAB_OUTAGE", message: `GitLab API unavailable (HTTP ${status})`, retryable: true };
  return { code: "GITLAB_REQUEST_REJECTED", message: `GitLab API request rejected (HTTP ${status})`, retryable: false };
}

function unavailableGitlabObservation({ project, branch, baseBranch }, error) {
  return {
    available: false, lookup_complete: false, mr_lookup_complete: false,
    matching_mr_count: null, identity_match_count: null,
    open_mr_count: null, merged_mr_count: null, closed_mr_count: null, fork_mr_count: null,
    project,
    mr_number: null, mr_state: null,
    head_ref: branch, base_ref: baseBranch,
    head_project_id: null, target_project_id: null, fork: false,
    mr_head_sha: null, mr_base_sha: null, merge_sha: null, url: null,
    error,
  };
}

// The reviewed head GitLab binds diffs to: diff_refs.head_sha is the head of
// the live merge-request diff version; fall back to the MR head sha. A lagging
// or diverging value simply fails exactPublishedChangeRequest, so review and
// landing never bind to a stale head (fail closed, retry-safe).
function gitlabMrHeadSha(row) {
  return row?.diff_refs?.head_sha || row?.sha || null;
}

function sameGitlabProjectMr(row) {
  return row?.source_project_id != null && row.source_project_id === row.target_project_id;
}

// Mirrors the retained selectGithubPr decision ladder for GitLab facts:
// identity matches win, recorded closed MRs are adoptable, exact-head matches
// beat looser pools, and only a unique candidate is ever selected. Fork MRs
// (source_project_id !== target_project_id) never identity-match, matching the
// GitHub head-repo identity requirement.
function selectGitlabMr(rows, { branch, baseBranch, localHeadSha = null, recordedCrNumber = null }) {
  const rowsList = Array.isArray(rows) ? rows : [];
  const sameHead = (row) => row?.source_branch === branch && sameGitlabProjectMr(row);
  const identityMatches = rowsList.filter((row) => sameHead(row) && row.target_branch === baseBranch);
  const pool = identityMatches.length ? identityMatches : rowsList.filter(sameHead);
  const byState = (state) => pool.filter((row) => row.state === state);
  const open = byState("opened");
  const merged = byState("merged");
  const closed = byState("closed");
  const exactHead = (candidates) => localHeadSha ? candidates.filter((row) => gitlabMrHeadSha(row) === localHeadSha) : candidates;
  const exactOpen = exactHead(open);
  const exactMerged = exactHead(merged);
  const recordedClosed = Number.isInteger(recordedCrNumber) ? closed.filter((row) => row.iid === recordedCrNumber) : [];
  const reusable = [recordedClosed, exactOpen, exactMerged, open, merged].find((group) => group.length) || [];
  return {
    mr: reusable.length === 1 ? reusable[0] : null,
    matchingMrCount: reusable.length,
    identityMatchCount: identityMatches.length,
    openMrCount: open.length,
    mergedMrCount: merged.length,
    closedMrCount: closed.length,
    forkMrCount: rowsList.filter((row) => row?.source_branch === branch && !sameGitlabProjectMr(row)).length,
  };
}

async function observeGitlabChangeRequest({
  project,
  host = "gitlab.com",
  branch,
  baseBranch,
  localHeadSha = null,
  recordedCrNumber = null,
  transport = null,
  token = null,
}) {
  const resolvedToken = token || resolveGitlabToken();
  if (!resolvedToken) {
    return unavailableGitlabObservation({ project, branch, baseBranch }, {
      code: "GITLAB_AUTH_REQUIRED",
      message: "GitLab merge-request observation requires GITLAB_TOKEN/GITLAB_API_TOKEN or credentials available through `glab auth login`",
      retryable: false,
    });
  }
  const apiBase = gitlabApiBase(host);
  const url = `${apiBase}/projects/${encodeURIComponent(project)}/merge_requests`
    + `?source_branch=${encodeURIComponent(branch)}&state=all&per_page=100`;
  let response;
  try {
    response = await (transport || fetchTransport)({
      url,
      headers: { "private-token": resolvedToken, accept: "application/json" },
    });
  } catch (error) {
    return unavailableGitlabObservation({ project, branch, baseBranch }, {
      code: "GITLAB_OUTAGE", message: commandFailureLine(error), retryable: true,
    });
  }
  if (response.status !== 200) {
    return unavailableGitlabObservation({ project, branch, baseBranch }, gitlabRequestError(response.status));
  }
  let rows;
  try {
    rows = JSON.parse(response.body);
  } catch {
    return unavailableGitlabObservation({ project, branch, baseBranch }, {
      code: "GITLAB_RESPONSE_INVALID", message: "GitLab API returned a non-JSON merge-request response", retryable: false,
    });
  }
  if (!Array.isArray(rows)) {
    return unavailableGitlabObservation({ project, branch, baseBranch }, {
      code: "GITLAB_RESPONSE_INVALID", message: "GitLab API returned a non-list merge-request response", retryable: false,
    });
  }
  const selection = selectGitlabMr(rows, { branch, baseBranch, localHeadSha, recordedCrNumber });
  const mr = selection.mr;
  return {
    available: true,
    lookup_complete: true,
    mr_lookup_complete: true,
    matching_mr_count: selection.matchingMrCount, identity_match_count: selection.identityMatchCount,
    open_mr_count: selection.openMrCount, merged_mr_count: selection.mergedMrCount,
    closed_mr_count: selection.closedMrCount, fork_mr_count: selection.forkMrCount,
    project,
    mr_number: mr?.iid ?? null, mr_state: mr?.state || null,
    head_ref: mr?.source_branch || branch, base_ref: mr?.target_branch || baseBranch,
    head_project_id: mr?.source_project_id ?? null, target_project_id: mr?.target_project_id ?? null,
    fork: mr ? !sameGitlabProjectMr(mr) : false,
    mr_head_sha: gitlabMrHeadSha(mr),
    mr_base_sha: mr?.diff_refs?.base_sha || null,
    merge_sha: mr?.merge_commit_sha || null,
    url: mr?.web_url || null,
  };
}

const gitlabChangeRequestAdapter = {
  provider: "gitlab",
  classifyRemote: classifyGitlabRemote,
  observeChangeRequest: observeGitlabChangeRequest,
  // Same exact-live-head binding decision as the GitHub route: a unique,
  // identity-matched change request whose live head equals the expected SHA.
  exactPublishedChangeRequest(observation, { branch }, headSha) {
    return observation?.available === true
      && observation.matching_mr_count === 1
      && Number.isInteger(observation.mr_number)
      && observation.head_ref === branch
      && observation.mr_head_sha === headSha;
  },
};

// ---------------------------------------------------------------------------
// Seam registry
// ---------------------------------------------------------------------------

const FORGE_ADAPTERS = Object.freeze({
  github: Object.freeze(githubChangeRequestAdapter),
  gitlab: Object.freeze(gitlabChangeRequestAdapter),
});

function classifyForgeRemote(remoteUrl) {
  return classifyGithubRemote(remoteUrl) || classifyGitlabRemote(remoteUrl) || { provider: null };
}

function getForgeAdapter(remoteUrl) {
  const classification = classifyForgeRemote(remoteUrl);
  return classification.provider ? FORGE_ADAPTERS[classification.provider] : null;
}

module.exports = {
  FORGE_ADAPTERS,
  classifyForgeRemote,
  getForgeAdapter,
  githubChangeRequestAdapter: FORGE_ADAPTERS.github,
  gitlabChangeRequestAdapter: FORGE_ADAPTERS.gitlab,
};
