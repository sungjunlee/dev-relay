const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  getCanonicalRepoRoot,
  getExpectedManifestRepoRoot,
  getRunDir,
  parsePositiveInt,
  validateManifestPaths,
} = require("../../../relay-dispatch/scripts/manifest/paths");
const { STATES } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { resolveManifestRecord } = require("../../../relay-dispatch/scripts/relay-resolver");
const {
  DEFAULT_EXEC_MAX_BUFFER_BYTES,
} = require("../../../relay-dispatch/scripts/exec");
const { gh, git, readText } = require("./common");

// Keep the generated-diff guard strictly below the subprocess read ceiling by
// deriving it from that ceiling. This leaves enough headroom to read a large
// diff before replacing it with a bounded review representation.
const GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES = DEFAULT_EXEC_MAX_BUFFER_BYTES / 32;

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

function resolveContext(repoPath, repoArg, manifestPathArg, runIdArg, branchArg, prArg, doneCriteriaFileArg = null) {
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
    expectedRepoRoot: manifestPathArg ? undefined : getExpectedManifestRepoRoot(repoPath, repoArg),
    manifestPath: manifest.manifestPath,
    runId: manifest.data?.run_id,
    requireWorktree: true,
    caller: "review-runner",
  });

  branch = branch || manifest.data?.git?.working_branch || null;
  prNumber = prNumber || manifest.data?.git?.pr_number || null;
  const runRepoPath = validatedPaths.repoRoot;
  // Internal review intentionally runs before PR creation; branch lookup only applies after publication.
  if (!prNumber && branch && manifest.data?.state !== STATES.INTERNAL_REVIEW_PENDING) {
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
      let persistedHint = "";
      if (manifestData?.anchor?.done_criteria_source !== "request_snapshot" && manifestData?.run_id) {
        try {
          const persistedPath = path.join(getRunDir(repoPath, manifestData.run_id), "done-criteria.md");
          persistedHint = ` Newer runs persist a run-dir copy at ${persistedPath}.`;
        } catch {}
      }
      throw new Error(
        `Manifest anchor.done_criteria_path points to a missing file: ${manifestDoneCriteriaPath}.` +
        persistedHint
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

function resolveDiffBase(reviewRepoPath, manifestData) {
  const baseBranch = manifestData?.git?.base_branch || "main";
  const candidates = [
    `origin/${baseBranch}`,
    baseBranch,
  ];
  for (const candidate of candidates) {
    try {
      return git(reviewRepoPath, "merge-base", "HEAD", candidate).trim();
    } catch {}
  }
  return null;
}

function loadRetainedWorktreeDiff(reviewRepoPath, manifestData) {
  if (!reviewRepoPath) {
    throw new Error("Retained review checkout is required to build an internal review diff.");
  }
  const base = resolveDiffBase(reviewRepoPath, manifestData);
  if (base) {
    const committed = git(reviewRepoPath, "diff", `${base}..HEAD`).trim();
    const unstaged = git(reviewRepoPath, "diff").trim();
    const staged = git(reviewRepoPath, "diff", "--cached").trim();
    return [committed, unstaged, staged].filter(Boolean).join("\n");
  }
  const startHead = manifestData?.dispatch?.start_head || manifestData?.git?.base_sha || null;
  if (startHead) {
    return git(reviewRepoPath, "diff", `${startHead}..HEAD`).trim();
  }
  throw new Error(
    "Cannot resolve a base for retained worktree diff. Provide --diff-file or ensure git.base_branch is available locally."
  );
}

function isMaxBufferError(error) {
  return error?.code === "ENOBUFS" || /\bENOBUFS\b/.test(String(error?.message || error));
}

function observedOutputBytes(error) {
  const output = error?.stdout ?? error?.output?.[1] ?? "";
  if (Buffer.isBuffer(output)) return output.length;
  return Buffer.byteLength(String(output), "utf-8");
}

function wrapGeneratedDiffReadError(error, source) {
  if (!isMaxBufferError(error)) throw error;
  const observedBytes = Math.max(
    observedOutputBytes(error),
    DEFAULT_EXEC_MAX_BUFFER_BYTES + 1
  );
  const wrapped = new Error(
    `Generated review diff read failed for ${source}: ` +
    `observed_size>=${observedBytes} bytes, ` +
    `maxBuffer_limit=${DEFAULT_EXEC_MAX_BUFFER_BYTES} bytes. ` +
    "Provide a curated --diff-file to review this change."
  );
  wrapped.cause = error;
  return wrapped;
}

function parseNumstatPaths(numstat) {
  return String(numstat)
    .split("\0")
    .filter(Boolean)
    .map((record) => record.split("\t").at(-1))
    .filter(Boolean);
}

function fallbackPatchSummary(diffText) {
  const sections = String(diffText).split(/(?=^diff --git )/m).filter(Boolean);
  const rows = [];
  const paths = [];
  for (const section of sections) {
    const pathMatch = section.match(/^diff --git .* b\/(.+)$/m);
    if (!pathMatch) continue;
    const filePath = pathMatch[1];
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of section.split("\n")) {
      if (line.startsWith("@@")) {
        inHunk = true;
      } else if (inHunk && line.startsWith("+") && !line.startsWith("+++")) {
        additions += 1;
      } else if (inHunk && line.startsWith("-") && !line.startsWith("---")) {
        deletions += 1;
      }
    }
    rows.push(` ${filePath} | ${additions + deletions} (+${additions} -${deletions})`);
    paths.push(filePath);
  }
  return {
    paths,
    stat: rows.length
      ? `${rows.join("\n")}\n ${rows.length} file${rows.length === 1 ? "" : "s"} changed`
      : " (unable to parse per-file statistics from generated diff)",
  };
}

function buildDegradedDiff(repoPath, diffText, source) {
  const observedBytes = Buffer.byteLength(diffText, "utf-8");
  let stat;
  let paths;
  try {
    stat = git(repoPath, "apply", "--stat", "-", {
      input: diffText,
    }).trim();
    const numstat = git(repoPath, "apply", "--numstat", "-z", "-", {
      input: diffText,
      raw: true,
    });
    paths = parseNumstatPaths(numstat);
  } catch {
    ({ stat, paths } = fallbackPatchSummary(diffText));
  }
  const uniquePaths = [...new Set(paths)];
  const omittedFiles = uniquePaths.length
    ? uniquePaths.map((filePath) => `- ${filePath}`).join("\n")
    : "- (file names unavailable)";

  return [
    `# ...generated diff degraded: observed ${observedBytes} bytes; ` +
      `threshold ${GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES} bytes; source ${source}`,
    "",
    "# --stat summary (full patches omitted)",
    stat,
    "",
    "# Files with omitted patches",
    omittedFiles,
  ].join("\n");
}

function guardGeneratedDiff(repoPath, diffText, source) {
  if (Buffer.byteLength(diffText, "utf-8") <= GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES) {
    return diffText;
  }
  return buildDegradedDiff(repoPath, diffText, source);
}

function loadDiff(repoPath, prNumber, diffFile, options = {}) {
  if (diffFile) return readText(diffFile).trim();
  if (options.internalReview) {
    try {
      const diffText = loadRetainedWorktreeDiff(options.reviewRepoPath, options.manifestData);
      return guardGeneratedDiff(options.reviewRepoPath, diffText, "internal git diff");
    } catch (error) {
      throw wrapGeneratedDiffReadError(error, "internal git diff");
    }
  }
  if (!prNumber) {
    throw new Error("PR number is required to fetch a diff. Provide --diff-file for fixture-based runs.");
  }
  try {
    const diffText = gh(repoPath, "pr", "diff", String(prNumber)).trim();
    return guardGeneratedDiff(repoPath, diffText, `gh pr diff #${prNumber}`);
  } catch (error) {
    throw wrapGeneratedDiffReadError(error, `gh pr diff #${prNumber}`);
  }
}

function summarizeStatusCheck(check) {
  const name = check?.name || check?.context || check?.workflowName || check?.app?.name || "unnamed check";
  const state = check?.conclusion || check?.status || check?.state || "unknown";
  return `- ${name}: ${state}`;
}

function summarizeReview(review) {
  const author = review?.author?.login || review?.user?.login || "unknown";
  const state = review?.state || "unknown";
  const body = String(review?.body || "").trim().replace(/\s+/g, " ").slice(0, 240);
  return `- ${author}: ${state}${body ? ` — ${body}` : ""}`;
}

function summarizeComment(comment) {
  const author = comment?.author?.login || comment?.user?.login || "unknown";
  const body = String(comment?.body || "").trim().replace(/\s+/g, " ").slice(0, 240);
  return body ? `- ${author}: ${body}` : null;
}

function summarizeReviewThread(thread) {
  const comments = Array.isArray(thread?.comments?.nodes)
    ? thread.comments.nodes
    : Array.isArray(thread?.comments)
      ? thread.comments
      : [];
  const first = comments[0] || {};
  const author = first?.author?.login || first?.user?.login || "unknown";
  const body = String(first?.body || "").trim().replace(/\s+/g, " ").slice(0, 240);
  const path = thread?.path || first?.path || "unknown path";
  const line = thread?.line || first?.line || first?.originalLine || "?";
  const state = thread?.isResolved ? "resolved" : thread?.isOutdated ? "outdated" : "unresolved";
  return `- ${state} ${path}:${line} ${author}${body ? ` — ${body}` : ""}`;
}

function resolveRepoOwnerName(repoPath) {
  const raw = gh(repoPath, "repo", "view", "--json", "owner,name");
  const parsed = JSON.parse(raw);
  const owner = parsed.owner?.login || parsed.owner?.name || parsed.owner;
  const name = parsed.name;
  if (!owner || !name) {
    throw new Error("gh repo view did not return owner/name");
  }
  return { owner, name };
}

function loadReviewThreads(repoPath, prNumber) {
  const { owner, name } = resolveRepoOwnerName(repoPath);
  const query = `
query($owner: String!, $name: String!, $number: Int!, $threadsCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $threadsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            nodes {
              author { login }
              body
              path
              line
              originalLine
            }
          }
        }
      }
    }
  }
}`;
  const threads = [];
  let cursor = null;
  do {
    const args = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${owner}`,
      "-F", `name=${name}`,
      "-F", `number=${prNumber}`,
    ];
    if (cursor) args.push("-F", `threadsCursor=${cursor}`);
    const raw = gh(repoPath, ...args);
    const parsed = JSON.parse(raw);
    const page = parsed.data?.repository?.pullRequest?.reviewThreads || {};
    threads.push(...(page.nodes || []));
    cursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

function loadPrReviewSignals(repoPath, prNumber) {
  if (!prNumber) {
    return { status: "not_available", reason: "no_pr" };
  }
  try {
    const raw = gh(
      repoPath,
      "pr", "view", String(prNumber),
      "--json", "statusCheckRollup,reviews,comments"
    );
    const parsed = JSON.parse(raw);
    const reviewThreads = loadReviewThreads(repoPath, prNumber);
    return {
      status: "loaded",
      checks: Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup.map(summarizeStatusCheck) : [],
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews.map(summarizeReview) : [],
      comments: Array.isArray(parsed.comments) ? parsed.comments.map(summarizeComment).filter(Boolean) : [],
      reviewThreads: Array.isArray(reviewThreads) ? reviewThreads.map(summarizeReviewThread) : [],
    };
  } catch (error) {
    // Keep signal loading non-throwing so review artifacts remain auditable; PASS is blocked later.
    return {
      status: "failed",
      reason: String(error.message || error).split("\n")[0],
    };
  }
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
  const { getAppliedVerdict } = require("./verdict");

  const lines = [];
  scanPriorVerdicts(runDir, round, (verdict, roundNum) => {
    const appliedVerdict = getAppliedVerdict(verdict);
    const label = appliedVerdict && appliedVerdict !== verdict?.verdict
      ? `${verdict.verdict} (applied: ${appliedVerdict})`
      : verdict.verdict;
    const parts = [`### Round ${roundNum}: ${label}`, verdict.summary];
    if (verdict.original_reviewer_verdict) {
      parts.push(
        `Primary reviewer verdict: ${String(verdict.original_reviewer_verdict.verdict || "unknown").toUpperCase()} `
        + `(next_action=${verdict.original_reviewer_verdict.next_action || "unknown"})`,
        `Primary reviewer summary: ${verdict.original_reviewer_verdict.summary || "unknown"}`,
        `Applied verdict: ${String(appliedVerdict || verdict.verdict || "unknown").toUpperCase()}`
      );
    }
    if (verdict.relay_escalation) {
      parts.push(
        `Relay escalation: trigger=${verdict.relay_escalation.trigger || "unknown"}; `
        + `reason=${verdict.relay_escalation.reason || "unknown"}`
      );
    }
    if (Array.isArray(verdict.issues) && verdict.issues.length) {
      parts.push(
        "Issues flagged:",
        formatIssueList(verdict.issues)
      );
    }
    lines.push(parts.join("\n"));
  });
  if (!lines.length) return "";

  return ["## Prior Round Context", "", "Verify whether prior issues were resolved.", "", ...lines].join("\n");
}

module.exports = {
  GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES,
  applyReviewerIdentity,
  formatPriorRoundContext,
  getExpectedManifestRepoRoot,
  getGhLogin,
  hostHasGhAuth,
  isValidHostname,
  loadDiff,
  loadDoneCriteria,
  loadPrReviewSignals,
  loadRetainedWorktreeDiff,
  loadProjectConventions,
  parseRemoteHost,
  resolveContext,
  resolveIssueNumber,
  resolveRemoteHost,
};
