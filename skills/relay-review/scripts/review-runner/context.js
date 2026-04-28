const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  getCanonicalRepoRoot,
  validateManifestPaths,
} = require("../../../relay-dispatch/scripts/manifest/paths");
const { resolveManifestRecord } = require("../../../relay-dispatch/scripts/relay-resolver");
const { getRubricAnchorStatus } = require("../../../relay-dispatch/scripts/manifest/rubric");
const { gh, looksLikeGitRepo, parsePositiveInt, readText } = require("./common");

const RUBRIC_PASS_THROUGH_STATES = new Set(["loaded"]);

// DNS hostname validation — conservative label allowlist. Rejects leading
// dashes (which could be interpreted as flags by some CLI tools), whitespace,
// empty strings, and other malformed values. Accepts FQDNs and single-label
// hosts that some enterprise setups still use internally.
const DNS_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);

function isValidHostname(host) {
  return typeof host === "string" && host.length > 0 && host.length <= 253 && HOSTNAME_RE.test(host);
}

function parseRemoteHost(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;

  // HTTP(S) — use WHATWG URL so credentials (https://user@host/...) and ports
  // don't contaminate the hostname. URL also lowercases/normalizes the host.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return isValidHostname(parsed.hostname) ? parsed.hostname : null;
    } catch {
      return null;
    }
  }

  // ssh:// URL form — WHATWG URL parses this too.
  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return isValidHostname(parsed.hostname) ? parsed.hostname : null;
    } catch {
      return null;
    }
  }

  // scp-like SSH: [user@]host:path. Git accepts both `user@host:owner/repo`
  // and `host:owner/repo` (no user) as valid remote forms. The optional user
  // group uses a char class that disallows further @ or :, and the host
  // group likewise, so inputs like `a@b@c:d/e` fail to match (no single
  // user+host split satisfies both char classes). The `(?!//)` lookahead
  // after the colon keeps `foo://bar` shapes from falling through here.
  const scpMatch = trimmed.match(/^(?:([^@\s:/]+)@)?([^@:/\s]+):(?!\/\/)/);
  if (scpMatch) {
    const host = scpMatch[2];
    // Windows drive-letter guard: `C:/foo` parses as scp-like under Git's
    // legacy heuristic but is clearly a local path, not a remote host.
    // Reject single-ASCII-letter hosts — single-label SSH hosts are vanishingly
    // rare in practice, and rejecting them costs nothing while closing the
    // `C:/...` ambiguity cleanly.
    if (/^[A-Za-z]$/.test(host)) return null;
    if (isValidHostname(host)) return host;
  }

  return null;
}

function resolveRemoteHost(repoPath) {
  if (!repoPath) return null;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return parseRemoteHost(url);
  } catch {
    return null;
  }
}

// Returns { login, status }.
//   login: resolved GitHub login string, or null if not available
//   status: "recorded"          → login is set, normal path
//           "host_auth_failed"  → origin host was resolvable AND gh has
//                                 auth configured for that host BUT the
//                                 host-scoped call could not return a
//                                 login. Callers MUST record this as a
//                                 gating condition on the manifest so
//                                 relay-merge refuses merge — otherwise the
//                                 fail-closed claim silently degrades into
//                                 a skipped author-verification gate.
//           "no_login"          → origin unresolvable / origin host has no
//                                 gh auth configured / zero-arg gh also
//                                 failed. Callers may record nothing
//                                 (matches pre-existing gate-check
//                                 "missing = soft-skip" semantics).
//
// Why the gh-auth-status probe: some origin hosts are SSH transports only
// (ssh.github.com on github.com), and some GHE setups keep SSH and API on
// separate hostnames. Calling `gh api user --hostname <transport-host>`
// would fail with an auth error even though the operator is fully
// authenticated via the API host. The probe distinguishes "GHE with
// host-scoped auth set up, use --hostname" from "transport-only or
// un-authed host, fall back to the default host (which is the same host
// `gh pr comment` uses, so gate-check lines up)".
function hostHasGhAuth(host) {
  try {
    execFileSync("gh", ["auth", "status", "--hostname", host], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function getGhLogin(repoPath) {
  const host = resolveRemoteHost(repoPath);

  if (host && hostHasGhAuth(host)) {
    // gh confirms auth for this host. Host-scoped call is the only
// acceptable source of reviewer_login; falling back to zero-arg would
    // silently write the default-host identity (the #199 bug).
    const args = ["--hostname", host, "api", "user", "--jq", ".login"];
    try {
      const login = execFileSync("gh", args, { encoding: "utf-8", stdio: "pipe" }).trim();
      if (login) return { login, status: "recorded" };
      console.error(
        `Warning: gh api user --hostname ${host} returned empty login — ` +
        `reviewer_login will not be recorded; relay-merge will refuse to merge without it.`
      );
      return { login: null, status: "host_auth_failed" };
    } catch (error) {
      console.error(
        `Warning: gh api user --hostname ${host} failed — ` +
        `reviewer_login will not be recorded; relay-merge will refuse to merge without it. ` +
        `Cause: ${error.message || error}`
      );
      return { login: null, status: "host_auth_failed" };
    }
  }

  // One of:
  //   (a) origin unresolvable (manifest-only run, no git repo),
  //   (b) origin resolved but gh has no auth for that host — typical for
  //       transport-only hosts like ssh.github.com (github.com repo) and
  //       for GHE repos where the operator hasn't run
  //       `gh auth login --hostname <host>` yet.
  // In both cases, zero-arg gh is the matching signal: it uses the
  // default host, which is the same identity `gh pr comment` uses when
  // no --hostname is provided — so reviewer_login lines up with the
  // actual comment author at gate-check time.
  try {
    const login = execFileSync("gh", ["api", "user", "--jq", ".login"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (login) return { login, status: "recorded" };
    console.error(
      "Warning: gh api user returned empty login — " +
      "reviewer_login will not be recorded, author verification will be skipped at merge time."
    );
    return { login: null, status: "no_login" };
  } catch (error) {
    console.error(
      `Warning: could not determine GitHub login for reviewer verification — ` +
      `reviewer_login will not be recorded, author verification will be skipped at merge time. ` +
      `Cause: ${error.message || error}`
    );
    return { login: null, status: "no_login" };
  }
}

const PR_BODY_CLOSING_KEYWORD_RE = /\b(?:close|closes|fix|fixes|resolve|resolves)\s+#(\d+)\b/gi;

function uniquePositiveIssueNumbers(values) {
  const numbers = new Set();
  for (const value of values) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) {
      numbers.add(number);
    }
  }
  return [...numbers];
}

function resolvePrBodyClosingIssue(body) {
  const matches = String(body || "").matchAll(PR_BODY_CLOSING_KEYWORD_RE);
  const numbers = uniquePositiveIssueNumbers([...matches].map((match) => match[1]));
  if (numbers.length > 1) {
    throw new Error(
      `Ambiguous PR body closing keywords reference multiple issues: ${numbers.map((number) => `#${number}`).join(", ")}. ` +
      "Provide --done-criteria-file, manifest.issue.number, or anchor.done_criteria_path to select the Done Criteria source explicitly."
    );
  }
  return numbers[0] || null;
}

function resolveBranchIssueNumber(branch) {
  const issueMatch = String(branch || "").match(/issue-(\d+)/i);
  return issueMatch ? Number(issueMatch[1]) : null;
}

function resolveClosingReferenceIssue(closingIssuesReferences, prNumber) {
  const numbers = uniquePositiveIssueNumbers(
    (Array.isArray(closingIssuesReferences) ? closingIssuesReferences : [])
      .map((reference) => reference?.number)
  );
  if (numbers.length > 1) {
    throw new Error(
      `Ambiguous GitHub closing issue references for PR #${prNumber}: ${numbers.map((number) => `#${number}`).join(", ")}. ` +
      "Add manifest.issue.number, use one explicit PR body closing keyword (Fixes #N, Closes #N, or Resolves #N), " +
      "rename the branch to issue-N, or provide --done-criteria-file or anchor.done_criteria_path."
    );
  }
  return numbers[0] || null;
}

function hasFileBackedDoneCriteria(manifestData, options = {}) {
  return Boolean(options.doneCriteriaFile || options.skipIssueInference || manifestData?.anchor?.done_criteria_path);
}

function resolveIssueNumber(repoPath, prNumber, branch, manifestData, options = {}) {
  if (manifestData?.issue?.number) {
    return Number(manifestData.issue.number);
  }

  if (hasFileBackedDoneCriteria(manifestData, options)) return null;

  if (!prNumber) return resolveBranchIssueNumber(branch);

  const raw = gh(repoPath, "pr", "view", String(prNumber), "--json", "closingIssuesReferences,body,headRefName");
  const parsed = JSON.parse(raw);

  const bodyIssue = resolvePrBodyClosingIssue(parsed.body);
  if (bodyIssue) return bodyIssue;

  const branchSource = branch || parsed.headRefName || "";
  const branchIssue = resolveBranchIssueNumber(branchSource);
  if (branchIssue) return branchIssue;

  return resolveClosingReferenceIssue(parsed.closingIssuesReferences, prNumber);
}

function getExpectedManifestRepoRoot(repoPath) {
  return looksLikeGitRepo(repoPath) ? getCanonicalRepoRoot(repoPath) : undefined;
}

function resolvePrForBranch(repoPath, branch) {
  const raw = gh(repoPath, "pr", "list", "--head", branch, "--json", "number");
  const parsed = JSON.parse(raw);
  const match = parsed[0];
  return match ? Number(match.number) : null;
}

function resolveBranchForPr(repoPath, prNumber) {
  const raw = gh(repoPath, "pr", "view", String(prNumber), "--json", "headRefName");
  return JSON.parse(raw).headRefName;
}

function resolveContext(repoPath, manifestPathArg, runIdArg, branchArg, prArg, doneCriteriaFileArg = null) {
  let branch = branchArg;
  let prNumber = parsePositiveInt(prArg, "--pr");

  if (!branch && !prNumber && !manifestPathArg && !runIdArg) {
    throw new Error("Provide --run-id, --branch, --pr, or --manifest");
  }

  if (!branch && prNumber && !manifestPathArg && !runIdArg) {
    branch = resolveBranchForPr(repoPath, prNumber);
  }

  const manifest = resolveManifestRecord({
    repoRoot: repoPath,
    manifestPath: manifestPathArg,
    runId: runIdArg,
    branch,
    prNumber,
  });
  const validatedPaths = validateManifestPaths(manifest.data?.paths, {
    expectedRepoRoot: manifestPathArg ? undefined : getExpectedManifestRepoRoot(repoPath),
    manifestPath: manifest.manifestPath,
    runId: manifest.data?.run_id,
    requireWorktree: true,
    caller: "review-runner",
  });

  branch = branch || manifest.data?.git?.working_branch || null;
  prNumber = prNumber || manifest.data?.git?.pr_number || null;
  const runRepoPath = validatedPaths.repoRoot;
  if (!prNumber && branch) {
    prNumber = resolvePrForBranch(runRepoPath, branch);
  }
  const issueNumber = resolveIssueNumber(runRepoPath, prNumber, branch, manifest.data, {
    doneCriteriaFile: doneCriteriaFileArg,
  });
  const normalizedManifest = {
    ...manifest,
    data: {
      ...(manifest.data || {}),
      paths: {
        ...(manifest.data?.paths || {}),
        repo_root: validatedPaths.repoRoot,
        worktree: validatedPaths.worktree,
      },
    },
  };

  return {
    branch,
    issueNumber,
    manifest: normalizedManifest,
    prNumber,
    reviewRepoPath: validatedPaths.worktree,
    runRepoPath,
  };
}

function applyReviewerIdentity(updatedManifest, noComment, runRepoPath) {
  if (noComment) {
    return updatedManifest;
  }

  const { login: reviewerLogin, status: loginStatus } = getGhLogin(runRepoPath);
  const nextReview = { ...(updatedManifest.review || {}) };
  if (reviewerLogin) {
    // Successful lookup — record the login AND clear any stale
    // reviewer_login_required from an earlier round. Without the clear,
    // a previous host-auth-failed round would leave the flag set and
    // gate-check would still refuse even though this round recorded a
    // valid login.
    nextReview.reviewer_login = reviewerLogin;
    delete nextReview.reviewer_login_required;
  } else if (loginStatus === "host_auth_failed") {
    // Origin resolved to a host but host-scoped gh could not return a
    // login. Signal the gate: without this marker, relay-merge's
    // gate-check silently skips author verification when reviewer_login
    // is absent, which would defeat the fail-closed property this PR
    // claims. The gate-check companion change treats this flag as a
    // hard-stop.
    //
    // Critically, ALSO delete any stale reviewer_login from an earlier
    // round. Otherwise the flag-and-login combination would satisfy
    // gate-check's `reviewer_login_required && !reviewer_login` test
    // (because reviewer_login is still present from round N-1), the
    // gate would skip, and a later LGTM from any author could ride
    // that stale identity through merge.
    nextReview.reviewer_login_required = true;
    delete nextReview.reviewer_login;
  }
  updatedManifest.review = nextReview;
  return updatedManifest;
}

function loadDoneCriteria(repoPath, issueNumber, prNumber, doneCriteriaFile, manifestData) {
  if (doneCriteriaFile) return { text: readText(doneCriteriaFile).trim(), source: "file" };

  const manifestDoneCriteriaPath = manifestData?.anchor?.done_criteria_path;
  if (manifestDoneCriteriaPath) {
    if (!fs.existsSync(manifestDoneCriteriaPath)) {
      throw new Error(
        `Manifest anchor.done_criteria_path points to a missing file: ${manifestDoneCriteriaPath}`
      );
    }
    return {
      text: readText(manifestDoneCriteriaPath).trim(),
      source: manifestData?.anchor?.done_criteria_source || "request_snapshot",
    };
  }

  const errors = [];

  // Primary: GitHub issue body (authored by the task creator)
  if (issueNumber) {
    try {
      const raw = gh(repoPath, "issue", "view", String(issueNumber), "--json", "title,body,number");
      const parsed = JSON.parse(raw);
      const text = `# Issue #${parsed.number}: ${parsed.title}\n\n${String(parsed.body || "").trim()}`.trim();
      if (text) return { text, source: "github-issue" };
    } catch (error) {
      errors.push(`issue #${issueNumber}: ${error.message.split("\n")[0]}`);
    }
  }

  // Fallback: PR description — written by the executor, not the task creator.
  // Lower trust: a compromised executor could manipulate the reviewer's anchor.
  if (prNumber) {
    try {
      const raw = gh(repoPath, "pr", "view", String(prNumber), "--json", "title,body,number");
      const parsed = JSON.parse(raw);
      const body = String(parsed.body || "").trim();
      if (body) {
        process.stderr.write(
          "  [WARN] Done Criteria sourced from PR body (executor-authored), not GitHub issue.\n" +
          "  PR body has lower trust — the executor could have altered the acceptance criteria.\n"
        );
        return { text: `# PR #${parsed.number}: ${parsed.title}\n\n${body}`.trim(), source: "pr-body" };
      }
    } catch (error) {
      errors.push(`PR #${prNumber}: ${error.message.split("\n")[0]}`);
    }
  }

  const detail = errors.length ? ` Attempted: ${errors.join("; ")}` : "";
  throw new Error(
    `Cannot resolve Done Criteria: no issue, no PR description.${detail} ` +
    "Provide --done-criteria-file or persist anchor.done_criteria_path for tasks without a GitHub issue."
  );
}

function loadDiff(repoPath, prNumber, diffFile) {
  if (diffFile) return readText(diffFile).trim();
  if (!prNumber) {
    throw new Error("PR number is required to fetch a diff. Provide --diff-file for fixture-based runs.");
  }
  return gh(repoPath, "pr", "diff", String(prNumber)).trim();
}

function loadProjectConventions(reviewRepoPath) {
  const repoRoot = getCanonicalRepoRoot(reviewRepoPath);
  const conventionsPath = path.join(repoRoot, ".gitignore");
  try {
    const realPath = fs.realpathSync(conventionsPath);
    const relative = path.relative(repoRoot, realPath);
    if (relative && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return "";
    const fd = fs.openSync(realPath, "r");
    try {
      const buffer = Buffer.alloc(2048);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytes).toString("utf-8");
      return fs.statSync(realPath).size > buffer.length ? `${text}${text.endsWith("\n") ? "" : "\n"}# ...truncated at 2KB` : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function formatPriorRoundContext(runDir, round) {
  if (!runDir || round <= 1) return "";

  const { scanPriorVerdicts } = require("./redispatch");
  const { formatIssueList } = require("./comment");

  const lines = [];
  scanPriorVerdicts(runDir, round, (verdict, roundNum) => {
    const parts = [`### Round ${roundNum}: ${verdict.verdict}`, verdict.summary];
    if (Array.isArray(verdict.issues) && verdict.issues.length) {
      parts.push("Issues flagged:", formatIssueList(verdict.issues));
    }
    lines.push(parts.join("\n"));
  });
  if (!lines.length) return "";

  return ["## Prior Round Context", "", "Verify whether prior issues were resolved.", "", ...lines].join("\n");
}

function formatRubricWarning(label, rubricAnchor) {
  const details = [];
  if (rubricAnchor.rubricPath) {
    details.push(`anchor.rubric_path=${JSON.stringify(rubricAnchor.rubricPath)}`);
  }
  if (rubricAnchor.resolvedPath) {
    details.push(`resolved_path=${JSON.stringify(rubricAnchor.resolvedPath)}`);
  }
  return [
    `WARNING: [${label}] ${rubricAnchor.error}`,
    details.length ? `Context: ${details.join(", ")}` : null,
    "Do NOT return PASS or ready_to_merge while this warning is present. Flag the invariant failure in the review output.",
  ].filter(Boolean).join("\n");
}

function createRubricLoad({ state, status, content, warning, rubricPath, resolvedPath, error }) {
  if (!RUBRIC_PASS_THROUGH_STATES.has(state) && warning === null) {
    throw new Error(`Rubric load state '${state}' must include a visible warning`);
  }
  return {
    state,
    status,
    content,
    warning,
    rubricPath,
    resolvedPath,
    error,
  };
}

function loadRubricFromRunDir(runDir, manifestData) {
  const rubricAnchor = getRubricAnchorStatus(manifestData, { runDir, includeContent: true });
  switch (rubricAnchor.status) {
    case "satisfied":
      return createRubricLoad({
        state: "loaded",
        status: rubricAnchor.status,
        content: rubricAnchor.content,
        warning: null,
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "missing_path":
      return createRubricLoad({
        state: "not_set",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric path not set", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "missing":
      return createRubricLoad({
        state: "missing",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric missing", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "outside_run_dir":
      return createRubricLoad({
        state: "outside_run_dir",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric path outside run dir", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "empty":
      return createRubricLoad({
        state: "empty",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric empty", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    default:
      return createRubricLoad({
        state: "invalid",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric invalid", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
  }
}

module.exports = {
  applyReviewerIdentity,
  createRubricLoad,
  formatPriorRoundContext,
  formatRubricWarning,
  getExpectedManifestRepoRoot,
  getGhLogin,
  hostHasGhAuth,
  isValidHostname,
  loadDiff,
  loadDoneCriteria,
  loadProjectConventions,
  loadRubricFromRunDir,
  parseRemoteHost,
  resolveContext,
  resolveIssueNumber,
  resolveRemoteHost,
};
