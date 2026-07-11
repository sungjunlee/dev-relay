const fs = require("fs");
const os = require("os");
const path = require("path");

const mergeGateResponse = (fixture) => ({
  baseRefName: fixture.baseRefName || "main",
  comments: fixture.comments || [],
  commits: fixture.commits || [],
  mergeable: fixture.mergeable || "MERGEABLE",
  statusCheckRollup: fixture.statusCheckRollup || [],
  headRefOid: fixture.headRefOid || "a".repeat(40),
  title: fixture.title || "Fixture PR",
});

const bodySnapshotResponse = (fixture) => ({
  body: fixture.body || "",
  headRefOid: fixture.headRefOid || "a".repeat(40),
  headRefName: fixture.headRefName || "",
  closingIssuesReferences: fixture.closingIssuesReferences || [],
});

// This is the fixture's single source of truth for accepted gh pr view field lists.
// Keep builders deterministic: generated fake-gh scripts serialize their return values.
const PR_VIEW_JSON_REGISTRY = Object.freeze({
  "statusCheckRollup,reviews,comments": (fixture) => ({
    statusCheckRollup: fixture.statusCheckRollup || [],
    reviews: fixture.reviews || [],
    comments: fixture.comments || [],
  }),
  "closingIssuesReferences,body,headRefName": (fixture) => ({
    closingIssuesReferences: fixture.closingIssuesReferences || [],
    body: fixture.body || "",
    headRefName: fixture.headRefName || "",
  }),
  "title,body,number": (fixture) => ({
    number: fixture.number || 123,
    title: fixture.title || "Fixture PR",
    body: fixture.body || "",
  }),
  "headRefName": (fixture) => ({ headRefName: fixture.headRefName || "" }),
  "number,headRefName,headRefOid": (fixture) => ({
    number: fixture.number || 123,
    headRefName: fixture.headRefName || "",
    headRefOid: fixture.headRefOid || "a".repeat(40),
  }),
  "state,mergeCommit": (_fixture, loadState) => {
    const state = loadState();
    return { state: state.state, mergeCommit: state.mergeCommit };
  },
  "comments,commits,mergeable,statusCheckRollup": mergeGateResponse,
  "baseRefName,comments,commits,mergeable,statusCheckRollup": mergeGateResponse,
  "baseRefName,comments,commits,mergeable,statusCheckRollup,headRefOid": mergeGateResponse,
  "baseRefName,comments,commits,mergeable,statusCheckRollup,headRefOid,title": mergeGateResponse,
  "comments,commits,headRefOid": mergeGateResponse,
  "comments,commits,headRefName,headRefOid": (fixture) => ({
    comments: fixture.comments || [],
    commits: fixture.commits || [],
    headRefName: fixture.headRefName || "",
    headRefOid: fixture.headRefOid || "a".repeat(40),
  }),
  "body": bodySnapshotResponse,
  "body,headRefOid,headRefName,closingIssuesReferences": bodySnapshotResponse,
  "headRefOid,headRefName,body,closingIssuesReferences": bodySnapshotResponse,
  "mergedAt,state": (fixture) => ({ mergedAt: fixture.mergedAt || null, state: fixture.state || "OPEN" }),
  "number,state,url,headRefName,mergedAt": (fixture) => ({
    number: fixture.number || 123,
    state: fixture.state || "OPEN",
    url: fixture.url || "",
    headRefName: fixture.headRefName || "",
    mergedAt: fixture.mergedAt || null,
  }),
});

function writeFakeGhScript({
  ghPath,
  fixture = {},
  capturePath = null,
  logPath = null,
  statePath = null,
  merge = null,
} = {}) {
  if (!ghPath) {
    throw new Error("writeFakeGhScript requires ghPath");
  }

  const serializedPrViewRegistry = Object.entries(PR_VIEW_JSON_REGISTRY)
    .map(([fields, builder]) => `${JSON.stringify(fields)}: ${builder.toString()}`)
    .join(",\n");

  const script = `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const args = process.argv.slice(2);
const fixture = ${JSON.stringify(fixture)};
const capturePath = ${JSON.stringify(capturePath)};
const logPath = ${JSON.stringify(logPath)};
const statePath = ${JSON.stringify(statePath)};
const merge = ${JSON.stringify(merge)};
const prViewJsonRegistry = {
${serializedPrViewRegistry}
};

if (logPath) {
  fs.appendFileSync(logPath, args.join(" ") + "\\n", "utf-8");
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function loadState() {
  if (statePath && fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
  }
  return {
    state: fixture.state || "OPEN",
    mergeCommit: fixture.mergeCommit || null,
  };
}

function saveState(next) {
  if (statePath) {
    fs.writeFileSync(statePath, JSON.stringify(next), "utf-8");
  }
}

if (fixture.failOnCall) {
  process.stderr.write("gh should not have been called");
  process.exit(91);
}

if (args[0] === "pr" && args[1] === "view") {
  const jsonIndex = args.indexOf("--json");
  const fields = jsonIndex >= 0 ? args[jsonIndex + 1] : "";

  // Snapshot callers use gh's jq path to read only the body as raw text.
  if (args.includes("-q") && args[args.indexOf("-q") + 1] === ".body") {
    process.stdout.write(fixture.body || "");
    process.exit(0);
  }

  const responseBuilder = prViewJsonRegistry[fields];
  if (responseBuilder) {
    writeJson(responseBuilder(fixture, loadState));
    process.exit(0);
  }

  // Some tests only need gh pr view to succeed; unsupported data stays empty.
  writeJson({});
  process.exit(0);
}

if (args[0] === "repo" && args[1] === "view") {
  writeJson({
    owner: { login: fixture.owner || "acme" },
    name: fixture.name || "dev-relay",
    defaultBranchRef: { name: fixture.defaultBranch || "main" },
  });
  process.exit(0);
}

if (args[0] === "api" && args[1] === "graphql") {
  const cursorArg = args.find((arg) => arg.startsWith("threadsCursor="));
  const pageIndex = cursorArg ? Number(cursorArg.split("=")[1].replace("page-", "")) : 0;
  const pages = fixture.reviewThreadPages || [{
    nodes: fixture.reviewThreads || [],
    pageInfo: { hasNextPage: false, endCursor: null },
  }];
  const page = pages[pageIndex] || { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const hasNextPage = pageIndex < pages.length - 1;
  writeJson({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: {
              hasNextPage,
              endCursor: hasNextPage ? "page-" + (pageIndex + 1) : null,
            },
            nodes: page.nodes || [],
          },
        },
      },
    },
  });
  process.exit(0);
}

if (args[0] === "api" && args[1] === "user") {
  process.stdout.write((fixture.login || "fixture-reviewer") + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "comment") {
  if (capturePath) {
    const bodyIndex = args.indexOf("--body");
    const body = bodyIndex !== -1 ? args[bodyIndex + 1] : "";
    fs.writeFileSync(capturePath, body, "utf-8");
  }
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "merge" && merge) {
  execFileSync("git", ["-C", merge.repoRoot, "checkout", merge.baseBranch || "main"], { stdio: "pipe" });
  execFileSync("git", ["-C", merge.repoRoot, "merge", "--squash", merge.branch], { stdio: "pipe" });
  execFileSync("git", ["-C", merge.repoRoot, "commit", "-m", merge.message || "Squash fixture branch"], { stdio: "pipe" });
  const sha = execFileSync("git", ["-C", merge.repoRoot, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();
  saveState({ state: "MERGED", mergeCommit: { oid: sha } });
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "close") {
  process.exit(0);
}

process.stderr.write("Unsupported fake gh invocation: " + args.join(" "));
process.exit(1);
`;

  fs.writeFileSync(ghPath, script, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

function installFakeGhOnPath(fixture = {}, options = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "relay-fake-gh-"));
  const ghPath = path.join(binDir, "gh");
  const originalPath = process.env.PATH;
  writeFakeGhScript({ ghPath, fixture, ...options });
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  let restored = false;
  const restore = () => {
    if (restored) return;
    process.env.PATH = originalPath;
    restored = true;
  };
  return { binDir, ghPath, restore };
}

function withFakeGh(fixture, callback, options = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), options.repoPrefix || "relay-review-gh-repo-"));
  const installed = installFakeGhOnPath(fixture, {
    prefix: options.binPrefix || "relay-review-gh-bin-",
    ...options,
  });

  try {
    return callback(repoRoot, installed);
  } finally {
    installed.restore();
  }
}

module.exports = {
  PR_VIEW_JSON_REGISTRY,
  installFakeGhOnPath,
  withFakeGh,
  writeFakeGhScript,
};
