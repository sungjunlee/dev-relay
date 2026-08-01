"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const runStore = require("../../../skills/relay-dispatch/scripts/run-store");

function initializeHostRun(runDir, { worktreeDir }) {
  const canonicalRunDir = fs.realpathSync(runDir);
  const canonicalWorktree = fs.realpathSync(worktreeDir);
  const doneCriteriaPath = path.join(canonicalRunDir, "done-criteria.md");
  const doneCriteria = Buffer.from("# Done Criteria\n\nHost fixture completes safely.\n", "utf8");
  fs.writeFileSync(doneCriteriaPath, doneCriteria);
  return runStore.createRunRecord({
    runDir: canonicalRunDir,
    record: {
      version: runStore.RUN_VERSION,
      run_id: path.basename(canonicalRunDir),
      repo: {
        root: canonicalWorktree,
        remote: "fixture/dev-relay",
      },
      git: {
        branch: "fixture",
        base_branch: "main",
        worktree: canonicalWorktree,
        start_sha: "1".repeat(40),
      },
      contract: {
        done_criteria_path: doneCriteriaPath,
        done_criteria_sha256: crypto.createHash("sha256").update(doneCriteria).digest("hex"),
      },
      roles: {
        orchestrator: "fixture",
        executor: "fixture",
        reviewer: "fixture",
      },
      parent: null,
      ownership_digest: null,
      created_at: new Date().toISOString(),
    },
  });
}

module.exports = { initializeHostRun };
