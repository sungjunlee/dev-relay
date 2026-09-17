"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FORGE_ADAPTERS,
  classifyForgeRemote,
  getForgeAdapter,
  githubChangeRequestAdapter,
  gitlabChangeRequestAdapter,
} = require("../../../skills/relay-dispatch/scripts/forge-adapters");
const recover = require("../../../skills/relay-dispatch/scripts/recover");

const RECOVER_SRC = fs.readFileSync(
  path.join(__dirname, "../../../skills/relay-dispatch/scripts/recover.js"),
  "utf8",
);
const GITHUB_PR_JSON_FIELDS = "number,state,url,headRefName,headRefOid,baseRefName,baseRefOid,headRepository,headRepositoryOwner,isCrossRepository,mergedAt,mergeCommit,body";

function retainedExactPublishedPr(github, branch, headSha) {
  return github.available === true
    && github.matching_pr_count === 1
    && Number.isInteger(github.pr_number)
    && github.head_ref === branch
    && github.pr_head_sha === headSha;
}

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function withEnv(overrides, callback) {
  const prior = {};
  for (const [key, value] of Object.entries(overrides)) {
    prior[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = callback();
    if (result && typeof result.then === "function") return Promise.resolve(result).finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function gitlabMr(overrides = {}) {
  return {
    iid: 12,
    state: "opened",
    source_branch: "issue-1210",
    target_branch: "main",
    source_project_id: 7,
    target_project_id: 7,
    sha: HEAD,
    diff_refs: { head_sha: HEAD, base_sha: BASE },
    merge_commit_sha: null,
    web_url: "https://gitlab.com/group/repo/-/merge_requests/12",
    ...overrides,
  };
}

function recordingTransport(responses) {
  const calls = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function jsonResponse(status, payload) {
  return { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

// ---------------------------------------------------------------------------
// Remote classification
// ---------------------------------------------------------------------------

test("#1210 classifies GitHub remotes with the retained production decision", () => {
  for (const [remote, project] of [
    ["git@github.com:Owner/Repo.git", "owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["https://github.com/owner/repo/", "owner/repo"],
    ["owner/repo", "owner/repo"],
  ]) {
    assert.deepEqual(classifyForgeRemote(remote), { provider: "github", project }, remote);
    assert.equal(getForgeAdapter(remote).provider, "github", remote);
  }
});

test("#1210 classifies gitlab.com remotes including nested groups and ssh ports", () => {
  for (const [remote, project] of [
    ["git@gitlab.com:group/repo.git", "group/repo"],
    ["https://gitlab.com/group/repo", "group/repo"],
    ["https://gitlab.com/group/sub/group/repo.git", "group/sub/group/repo"],
    ["ssh://git@gitlab.com:2222/group/repo.git", "group/repo"],
  ]) {
    assert.deepEqual(classifyForgeRemote(remote), { provider: "gitlab", project, host: "gitlab.com" }, remote);
    assert.equal(getForgeAdapter(remote).provider, "gitlab", remote);
  }
});

test("#1210 supports self-managed GitLab hosts only through RELAY_GITLAB_HOSTS", () => {
  const remote = "https://git.example.test/group/repo.git";
  assert.deepEqual(classifyForgeRemote(remote), { provider: null });
  assert.equal(getForgeAdapter(remote), null);
  withEnv({ RELAY_GITLAB_HOSTS: " git.example.test , other.example.test " }, () => {
    assert.deepEqual(classifyForgeRemote(remote), {
      provider: "gitlab", project: "group/repo", host: "git.example.test",
    });
  });
});

test("#1210 leaves non-forge and local identities unclassified and never claims owner/repo shorthand for GitLab", () => {
  assert.deepEqual(classifyForgeRemote("/srv/git/repo"), { provider: null });
  assert.deepEqual(classifyForgeRemote("https://bitbucket.example.test/owner/repo.git"), { provider: null });
  assert.deepEqual(classifyForgeRemote(""), { provider: null });
  // The bare shorthand keeps its retained GitHub decision even with GitLab hosts configured.
  withEnv({ RELAY_GITLAB_HOSTS: "gitlab.com" }, () => {
    assert.equal(classifyForgeRemote("group/repo").provider, "github");
  });
  // A single-segment GitLab path is not a project identity.
  assert.deepEqual(classifyForgeRemote("https://gitlab.com/repo"), { provider: null });
});

test("#1210 the seam registry holds exactly the two demonstrated implementations", () => {
  assert.deepEqual(Object.keys(FORGE_ADAPTERS).sort(), ["github", "gitlab"]);
  for (const adapter of Object.values(FORGE_ADAPTERS)) {
    assert.deepEqual(
      Object.keys(adapter).sort(),
      ["classifyRemote", "exactPublishedChangeRequest", "observeChangeRequest", "provider"],
      "no unused extension points",
    );
  }
  assert.match(
    RECOVER_SRC,
    new RegExp(`"--json", "${GITHUB_PR_JSON_FIELDS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    "GitHub observation JSON fields stay byte-identical to recover.js",
  );
  assert.match(RECOVER_SRC, /github\.pr_head_sha === headSha/);
  assert.match(RECOVER_SRC, /function exactPublishedPr\(github, record, headSha\)/);
});

// ---------------------------------------------------------------------------
// GitLab merge-request observation
// ---------------------------------------------------------------------------

test("#1210 maps GitLab merge-request identity and the exact live head into provider-specific facts", async () => {
  const { transport, calls } = recordingTransport([jsonResponse(200, [gitlabMr()])]);
  const observation = await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "issue-1210", baseBranch: "main",
    localHeadSha: HEAD, transport, token: "test-token",
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests?source_branch=issue-1210&state=all&per_page=100",
  );
  assert.deepEqual(calls[0].headers, { "private-token": "test-token", accept: "application/json" });

  assert.deepEqual(observation, {
    available: true,
    lookup_complete: true,
    mr_lookup_complete: true,
    matching_mr_count: 1, identity_match_count: 1,
    open_mr_count: 1, merged_mr_count: 0, closed_mr_count: 0, fork_mr_count: 0,
    project: "group/repo",
    mr_number: 12, mr_state: "opened",
    head_ref: "issue-1210", base_ref: "main",
    head_project_id: 7, target_project_id: 7, fork: false,
    mr_head_sha: HEAD, mr_base_sha: BASE, merge_sha: null,
    url: "https://gitlab.com/group/repo/-/merge_requests/12",
  });
  assert.equal(gitlabChangeRequestAdapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, HEAD), true);
});

test("#1210 honors GITLAB_API_URL and RELAY_GITLAB_HOSTS-derived API bases", async () => {
  const { transport, calls } = recordingTransport([jsonResponse(200, [])]);
  await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", host: "git.example.test", branch: "b", baseBranch: "main",
    transport, token: "t",
  });
  assert.match(calls[0].url, /^https:\/\/git\.example\.test\/api\/v4\/projects\/group%2Frepo\/merge_requests\?/);

  await withEnv({ GITLAB_API_URL: "https://proxy.example.test/api/v4/" }, async () => {
    const proxied = recordingTransport([jsonResponse(200, [])]);
    await gitlabChangeRequestAdapter.observeChangeRequest({
      project: "group/repo", branch: "b", baseBranch: "main",
      transport: proxied.transport, token: "t",
    });
    assert.match(proxied.calls[0].url, /^https:\/\/proxy\.example\.test\/api\/v4\/projects\//);
  });
});

test("#1210 binds the exact live head through diff_refs and fails closed on a diverging head", async () => {
  // The reviewed diff-version head wins over a lagging top-level sha.
  const { transport } = recordingTransport([jsonResponse(200, [gitlabMr({ sha: OTHER, diff_refs: { head_sha: HEAD, base_sha: BASE } })])]);
  const observation = await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "issue-1210", baseBranch: "main",
    localHeadSha: HEAD, transport, token: "t",
  });
  assert.equal(observation.mr_head_sha, HEAD);
  assert.equal(gitlabChangeRequestAdapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, HEAD), true);

  // A live head that moved since publication never binds review or landing.
  assert.equal(gitlabChangeRequestAdapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, OTHER), false);

  // A head that lags the local expectation is still observed (the retained
  // ladder reuses a unique open candidate) but never binds review or landing:
  // the exact-head decision fails closed and stays retry-safe.
  const lagging = recordingTransport([jsonResponse(200, [gitlabMr({ sha: OTHER, diff_refs: { head_sha: OTHER, base_sha: BASE } })])]);
  const laggingObservation = await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "issue-1210", baseBranch: "main",
    localHeadSha: HEAD, transport: lagging.transport, token: "t",
  });
  assert.equal(laggingObservation.mr_number, 12);
  assert.equal(laggingObservation.matching_mr_count, 1);
  assert.equal(laggingObservation.mr_head_sha, OTHER, "the observation reports the live head");
  assert.equal(gitlabChangeRequestAdapter.exactPublishedChangeRequest(laggingObservation, { branch: "issue-1210" }, HEAD), false);
});

test("#1210 keeps fork merge requests distinct from same-project branches", async () => {
  const fork = gitlabMr({ iid: 3, source_project_id: 99, target_project_id: 7 });
  const { transport } = recordingTransport([jsonResponse(200, [fork])]);
  const observation = await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "issue-1210", baseBranch: "main", transport, token: "t",
  });
  assert.equal(observation.available, true);
  assert.equal(observation.fork_mr_count, 1);
  assert.equal(observation.mr_number, null, "a fork MR is never identity-matched implicitly");
  assert.equal(observation.matching_mr_count, 0);
  assert.equal(gitlabChangeRequestAdapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, HEAD), false);
});

test("#1210 selects a unique candidate and fails ambiguity closed like the GitHub ladder", async () => {
  // Two opened MRs on the same branch: ambiguous, nothing selected.
  const ambiguous = recordingTransport([jsonResponse(200, [gitlabMr({ iid: 1 }), gitlabMr({ iid: 2 })])]);
  const ambiguousObservation = await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "issue-1210", baseBranch: "main", transport: ambiguous.transport, token: "t",
  });
  assert.equal(ambiguousObservation.mr_number, null);
  assert.equal(ambiguousObservation.matching_mr_count, 2);
  assert.equal(ambiguousObservation.open_mr_count, 2);

  // Identity match (target_branch) wins over a looser same-head candidate.
  const identityWins = recordingTransport([jsonResponse(200, [
    gitlabMr({ iid: 1, target_branch: "release" }),
    gitlabMr({ iid: 2 }),
  ])]);
  const identityObservation = await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "issue-1210", baseBranch: "main", transport: identityWins.transport, token: "t",
  });
  assert.equal(identityObservation.mr_number, 2);
  assert.equal(identityObservation.identity_match_count, 1);
  assert.equal(identityObservation.matching_mr_count, 1);

  // A recorded closed iid is adoptable for recovery of a known change request.
  const recorded = recordingTransport([jsonResponse(200, [
    gitlabMr({ iid: 5, state: "closed", merge_commit_sha: null }),
    gitlabMr({ iid: 6, state: "closed" }),
  ])]);
  const recordedObservation = await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "issue-1210", baseBranch: "main",
    recordedCrNumber: 6, transport: recorded.transport, token: "t",
  });
  assert.equal(recordedObservation.mr_number, 6);
  assert.equal(recordedObservation.mr_state, "closed");

  // A merged MR maps its merge commit into provider facts.
  const merged = recordingTransport([jsonResponse(200, [gitlabMr({
    iid: 9, state: "merged", merge_commit_sha: OTHER,
  })])]);
  const mergedObservation = await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "issue-1210", baseBranch: "main", transport: merged.transport, token: "t",
  });
  assert.equal(mergedObservation.mr_number, 9);
  assert.equal(mergedObservation.merge_sha, OTHER);
  assert.equal(mergedObservation.merged_mr_count, 1);
});

test("#1210 GitLab outages and permission failures stay typed, observable, and retry-safe", async () => {
  const cases = [
    [jsonResponse(401, { message: "401 Unauthorized" }), "GITLAB_AUTH_INVALID", false],
    [jsonResponse(403, { message: "403 Forbidden" }), "GITLAB_PERMISSION_DENIED", false],
    [jsonResponse(404, { message: "404 Not Found" }), "GITLAB_NOT_FOUND", false],
    [jsonResponse(400, { message: "bad request" }), "GITLAB_REQUEST_REJECTED", false],
    [jsonResponse(429, { message: "rate limited" }), "GITLAB_OUTAGE", true],
    [jsonResponse(503, "<html>unavailable</html>"), "GITLAB_OUTAGE", true],
    [new Error("connect ECONNREFUSED"), "GITLAB_OUTAGE", true],
    [jsonResponse(200, "not-json"), "GITLAB_RESPONSE_INVALID", false],
    [jsonResponse(200, { unexpected: "object" }), "GITLAB_RESPONSE_INVALID", false],
  ];
  for (const [response, code, retryable] of cases) {
    const { transport } = recordingTransport([response]);
    const observation = await gitlabChangeRequestAdapter.observeChangeRequest({
      project: "group/repo", branch: "issue-1210", baseBranch: "main", transport, token: "t",
    });
    assert.equal(observation.available, false, code);
    assert.equal(observation.lookup_complete, false, code);
    assert.equal(observation.error.code, code);
    assert.equal(observation.error.retryable, retryable, code);
    assert.equal(typeof observation.error.message, "string");
    assert.ok(observation.error.message.length > 0, code);
    assert.equal(observation.mr_number, null, code);
    assert.equal(observation.mr_head_sha, null, code);
    assert.equal(observation.head_ref, "issue-1210", code);
    assert.equal(gitlabChangeRequestAdapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, HEAD), false, code);
  }
});

test("#1210 missing GitLab credentials fail closed before any request", async () => {
  const dir = tmpDir("forge-adapters-glab-");
  try {
    const failingGlab = path.join(dir, "glab");
    fs.writeFileSync(failingGlab, "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
    const { transport, calls } = recordingTransport([]);
    const observation = await withEnv({
      GITLAB_TOKEN: null, GITLAB_API_TOKEN: null, RELAY_GLAB_BIN: failingGlab,
    }, () => gitlabChangeRequestAdapter.observeChangeRequest({
      project: "group/repo", branch: "issue-1210", baseBranch: "main", transport,
    }));
    assert.equal(calls.length, 0, "no forge request without credentials");
    assert.equal(observation.available, false);
    assert.equal(observation.error.code, "GITLAB_AUTH_REQUIRED");
    assert.equal(observation.error.retryable, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#1210 resolves GitLab credentials from GITLAB_TOKEN, GITLAB_API_TOKEN, and glab auth token", async () => {
  const env = recordingTransport([jsonResponse(200, [])]);
  await withEnv({ GITLAB_TOKEN: "env-token", GITLAB_API_TOKEN: null }, () => gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "b", baseBranch: "main", transport: env.transport,
  }));
  assert.equal(env.calls[0].headers["private-token"], "env-token");

  const apiToken = recordingTransport([jsonResponse(200, [])]);
  await withEnv({ GITLAB_TOKEN: null, GITLAB_API_TOKEN: "api-token" }, () => gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "b", baseBranch: "main", transport: apiToken.transport,
  }));
  assert.equal(apiToken.calls[0].headers["private-token"], "api-token");

  const dir = tmpDir("forge-adapters-glab-token-");
  try {
    const glab = path.join(dir, "glab");
    fs.writeFileSync(glab, "#!/usr/bin/env node\nprocess.stdout.write('glab-token\\n');\n", { mode: 0o755 });
    const probed = recordingTransport([jsonResponse(200, [])]);
    await withEnv({ GITLAB_TOKEN: null, GITLAB_API_TOKEN: null, RELAY_GLAB_BIN: glab }, () => gitlabChangeRequestAdapter.observeChangeRequest({
      project: "group/repo", branch: "b", baseBranch: "main", transport: probed.transport,
    }));
    assert.equal(probed.calls[0].headers["private-token"], "glab-token");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GitHub adapter — decision compatibility with the retained route
// ---------------------------------------------------------------------------

function writeFakeGh(dir, { rows = null, argvLog = null } = {}) {
  const script = path.join(dir, "gh");
  fs.writeFileSync(script, [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    argvLog ? `fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));` : "",
    rows === null
      ? "process.stderr.write('gh: could not resolve host\\n'); process.exit(1);"
      : `process.stdout.write(JSON.stringify(${JSON.stringify(rows)}));`,
    "",
  ].filter(Boolean).join("\n"), { mode: 0o755 });
  return script;
}

function githubRow(overrides = {}) {
  return {
    number: 42,
    state: "OPEN",
    url: "https://github.com/owner/repo/pull/42",
    headRefName: "issue-1210",
    headRefOid: HEAD,
    baseRefName: "main",
    baseRefOid: BASE,
    headRepository: { nameWithOwner: "owner/repo" },
    headRepositoryOwner: { login: "owner" },
    isCrossRepository: false,
    mergedAt: null,
    mergeCommit: null,
    body: "closes #1210",
    ...overrides,
  };
}

test("#1210 GitHub observation is decision-compatible with the retained observeGithub facts", async (t) => {
  const dir = tmpDir("forge-adapters-gh-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const argvLog = path.join(dir, "argv.json");
  const gh = writeFakeGh(dir, { rows: [githubRow()], argvLog });

  const observation = await withEnv({ RELAY_GH_BIN: gh }, () => githubChangeRequestAdapter.observeChangeRequest({
    project: "owner/repo", branch: "issue-1210", baseBranch: "main", localHeadSha: HEAD,
  }));

  // The seam issues the exact retained gh observation command.
  assert.deepEqual(JSON.parse(fs.readFileSync(argvLog, "utf8")), [
    "pr", "list", "--repo", "owner/repo", "--head", "issue-1210", "--state", "all", "--limit", "100",
    "--json", GITHUB_PR_JSON_FIELDS,
  ]);

  const row = githubRow();
  const selection = recover.__testing.selectGithubPr([row], {
    remote: "owner/repo", branch: "issue-1210", baseBranch: "main", localHeadSha: HEAD,
  });
  const pr = selection.pr;
  // Field-for-field the retained GitHub observation shape (recover.js observeGithub).
  assert.deepEqual(observation, {
    available: true,
    lookup_complete: true,
    pr_lookup_complete: true,
    matching_pr_count: selection.matchingPrCount, identity_match_count: selection.identityMatchCount,
    open_pr_count: selection.openPrCount, merged_pr_count: selection.mergedPrCount,
    closed_pr_count: selection.closedPrCount,
    repo: "owner/repo",
    pr_number: pr.number, pr_state: pr.state,
    head_ref: pr.headRefName, base_ref: pr.baseRefName,
    head_repo: selection.headRepo(pr),
    pr_head_sha: pr.headRefOid, pr_base_sha: pr.baseRefOid,
    merge_sha: pr.mergeCommit?.oid || null,
    url: pr.url, body: pr.body,
  });
  assert.equal(
    githubChangeRequestAdapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, HEAD),
    retainedExactPublishedPr(observation, "issue-1210", HEAD),
  );
  assert.equal(githubChangeRequestAdapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, HEAD), true);
  assert.equal(githubChangeRequestAdapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, OTHER), false);
  assert.equal("pr_number" in observation && !("mr_number" in observation), true);
});

test("#1210 GitHub selection reuses the retained ladder for ambiguous and fork heads", async (t) => {
  const dir = tmpDir("forge-adapters-gh-ladder-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ambiguous = writeFakeGh(dir, {
    rows: [githubRow({ number: 1 }), githubRow({ number: 2 })],
  });
  const ambiguousObservation = await withEnv({ RELAY_GH_BIN: ambiguous }, () => githubChangeRequestAdapter.observeChangeRequest({
    project: "owner/repo", branch: "issue-1210", baseBranch: "main",
  }));
  assert.equal(ambiguousObservation.pr_number, null);
  assert.equal(ambiguousObservation.matching_pr_count, 2);
  assert.equal(githubChangeRequestAdapter.exactPublishedChangeRequest(ambiguousObservation, { branch: "issue-1210" }, HEAD), false);

  // A fork-head PR (head repo differs from the canonical repo) never identity-matches.
  const fork = writeFakeGh(dir, {
    rows: [githubRow({ headRepository: { nameWithOwner: "contributor/repo" }, headRepositoryOwner: { login: "contributor" }, isCrossRepository: true })],
  });
  const forkObservation = await withEnv({ RELAY_GH_BIN: fork }, () => githubChangeRequestAdapter.observeChangeRequest({
    project: "owner/repo", branch: "issue-1210", baseBranch: "main", localHeadSha: HEAD,
  }));
  assert.equal(forkObservation.pr_number, null);
  assert.equal(forkObservation.matching_pr_count, 0);

  const recorded = writeFakeGh(dir, {
    rows: [githubRow({ number: 5, state: "CLOSED" }), githubRow({ number: 6, state: "CLOSED" })],
  });
  const recordedObservation = await withEnv({ RELAY_GH_BIN: recorded }, () => githubChangeRequestAdapter.observeChangeRequest({
    project: "owner/repo", branch: "issue-1210", baseBranch: "main", recordedCrNumber: 6,
  }));
  assert.equal(recordedObservation.pr_number, 6);
  assert.equal(recordedObservation.pr_state, "CLOSED");
});

test("#1210 GitHub observation failures stay typed and retry-safe", async (t) => {
  const dir = tmpDir("forge-adapters-gh-fail-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failingGh = writeFakeGh(dir, { rows: null });

  const observation = await withEnv({ RELAY_GH_BIN: failingGh }, () => githubChangeRequestAdapter.observeChangeRequest({
    project: "owner/repo", branch: "issue-1210", baseBranch: "main",
  }));
  assert.equal(observation.available, false);
  assert.equal(observation.lookup_complete, false);
  assert.equal(observation.error.code, "GITHUB_OBSERVATION_FAILED");
  assert.equal(observation.error.retryable, true);
  assert.match(observation.error.message, /could not resolve host/);
  assert.equal(observation.pr_number, null);
  assert.equal(observation.pr_head_sha, null);
  assert.equal(githubChangeRequestAdapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, HEAD), false);
});

// ---------------------------------------------------------------------------
// Seam-level guarantees
// ---------------------------------------------------------------------------

test("#1210 both implementations bind review and landing to the exact live change-request head", async (t) => {
  const dir = tmpDir("forge-adapters-exact-head-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = writeFakeGh(dir, { rows: [githubRow()] });
  const githubObservation = await withEnv({ RELAY_GH_BIN: gh }, () => githubChangeRequestAdapter.observeChangeRequest({
    project: "owner/repo", branch: "issue-1210", baseBranch: "main", localHeadSha: HEAD,
  }));

  const gitlab = recordingTransport([jsonResponse(200, [gitlabMr()])]);
  const gitlabObservation = await gitlabChangeRequestAdapter.observeChangeRequest({
    project: "group/repo", branch: "issue-1210", baseBranch: "main", transport: gitlab.transport, token: "t",
  });
  assert.equal("mr_number" in gitlabObservation && !("pr_number" in gitlabObservation), true);

  for (const [adapter, observation, matchingKey] of [
    [githubChangeRequestAdapter, githubObservation, "matching_pr_count"],
    [gitlabChangeRequestAdapter, gitlabObservation, "matching_mr_count"],
  ]) {
    assert.equal(adapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, HEAD), true);
    assert.equal(adapter.exactPublishedChangeRequest(observation, { branch: "issue-1210" }, OTHER), false, "stale head must not bind");
    assert.equal(adapter.exactPublishedChangeRequest({ ...observation, available: false }, { branch: "issue-1210" }, HEAD), false);
    assert.equal(adapter.exactPublishedChangeRequest({ ...observation, [matchingKey]: 2 }, { branch: "issue-1210" }, HEAD), false);
    assert.equal(adapter.exactPublishedChangeRequest(null, { branch: "issue-1210" }, HEAD), false);
  }
  assert.equal(
    githubChangeRequestAdapter.exactPublishedChangeRequest(githubObservation, { branch: "issue-1210" }, HEAD),
    retainedExactPublishedPr(githubObservation, "issue-1210", HEAD),
  );
});
