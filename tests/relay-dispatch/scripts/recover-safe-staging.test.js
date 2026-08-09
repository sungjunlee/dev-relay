"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const recover = require("../../../skills/relay-dispatch/scripts/recover");

function git(repo, args, { raw = false } = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: raw ? null : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fixture(label) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-stage-${label}-`)));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "relay@example.test"]);
  git(repo, ["config", "user.name", "Relay Test"]);
  fs.writeFileSync(path.join(repo, "old.txt"), "old\n");
  fs.writeFileSync(path.join(repo, "keep.txt"), "keep\n");
  git(repo, ["add", "old.txt", "keep.txt"]);
  git(repo, ["commit", "-qm", "initial"]);
  return repo;
}

function status(repo) {
  return git(repo, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { raw: true });
}

function indexTree(repo) { return git(repo, ["write-tree"]).trim(); }
function stagedNames(repo) {
  return git(repo, ["diff", "--cached", "--name-only", "-z"], { raw: true })
    .toString("utf8").split("\0").filter(Boolean).sort();
}

test("safe staging parses NUL rename and newline names while excluding metadata components", () => {
  const repo = fixture("names");
  fs.renameSync(path.join(repo, "old.txt"), path.join(repo, "renamed.txt"));
  git(repo, ["add", "-A"]); // Force a porcelain R record in the input snapshot.
  fs.writeFileSync(path.join(repo, "line\nbreak.txt"), "newline\n");
  fs.writeFileSync(path.join(repo, "quote\"name.txt"), "quoted\n");
  fs.writeFileSync(path.join(repo, ":(top)magic.txt"), "magic\n");
  fs.writeFileSync(path.join(repo, "star*file.txt"), "star\n");
  fs.writeFileSync(path.join(repo, "!bang.txt"), "bang\n");
  fs.mkdirSync(path.join(repo, "nested", ".codex"), { recursive: true });
  fs.writeFileSync(path.join(repo, "nested", ".codex", "session.json"), "runtime\n");
  const preTree = indexTree(repo);
  const staged = recover.__testing.stageReviewableWork(repo, status(repo));
  assert.deepEqual(staged.paths, ["!bang.txt", ":(top)magic.txt", "line\nbreak.txt", "quote\"name.txt", "renamed.txt", "star*file.txt"]);
  assert.deepEqual(stagedNames(repo), ["!bang.txt", ":(top)magic.txt", "line\nbreak.txt", "quote\"name.txt", "renamed.txt", "star*file.txt"]);
  assert.equal(stagedNames(repo).some((name) => name.includes(".codex")), false);
  staged.rollback();
  assert.equal(indexTree(repo), preTree);
});

test("porcelain v1 -z copy records consume both NUL path fields without quoting ambiguity", () => {
  const records = recover.__testing.parsePorcelainV1Z(Buffer.concat([
    Buffer.from("C  copied\nfile.txt\0source\"file.txt\0", "utf8"),
    Buffer.from("?? plain.txt\0", "utf8"),
  ]));
  assert.deepEqual(records, [
    { xy: "C ", current: "copied\nfile.txt", original: "source\"file.txt" },
    { xy: "??", current: "plain.txt", original: null },
  ]);
});

test("late metadata creation fails closed and restores the exact index tree", () => {
  const repo = fixture("late-metadata");
  fs.writeFileSync(path.join(repo, "keep.txt"), "changed\n");
  const preTree = indexTree(repo);
  assert.throws(() => recover.__testing.stageReviewableWork(repo, status(repo), {
    fault(stage) {
      if (stage === "after_git_add") {
        fs.mkdirSync(path.join(repo, ".cursor"));
        fs.writeFileSync(path.join(repo, ".cursor", "state"), "late\n");
      }
    },
  }), (error) => error.code === "WORKTREE_CHANGED");
  assert.equal(indexTree(repo), preTree);
  assert.equal(fs.readFileSync(path.join(repo, "keep.txt"), "utf8"), "changed\n");
  assert.equal(fs.readFileSync(path.join(repo, ".cursor", "state"), "utf8"), "late\n");
});

test("same-inode byte mutation before add fails closed without changing the index", () => {
  const repo = fixture("same-inode");
  const target = path.join(repo, "keep.txt");
  fs.writeFileSync(target, "first\n");
  const inode = fs.statSync(target).ino;
  const preTree = indexTree(repo);
  assert.throws(() => recover.__testing.stageReviewableWork(repo, status(repo), {
    fault(stage) {
      if (stage === "before_git_add") fs.appendFileSync(target, "late\n");
    },
  }), (error) => error.code === "WORKTREE_CHANGED");
  assert.equal(fs.statSync(target).ino, inode);
  assert.equal(fs.readFileSync(target, "utf8"), "first\nlate\n");
  assert.equal(indexTree(repo), preTree);
});

test("path replacement with a symlink before add is rejected and index is rolled back", () => {
  const repo = fixture("symlink-swap");
  const target = path.join(repo, "keep.txt");
  fs.writeFileSync(target, "changed\n");
  const preTree = indexTree(repo);
  assert.throws(() => recover.__testing.stageReviewableWork(repo, status(repo), {
    fault(stage) {
      if (stage === "before_git_add") {
        fs.unlinkSync(target);
        fs.symlinkSync("old.txt", target);
      }
    },
  }), (error) => error.code === "UNSAFE_WORKTREE_ENTRY");
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(indexTree(repo), preTree);
});

test("an untracked FIFO is rejected without reading special-file bytes", { timeout: 5_000 }, () => {
  const repo = fixture("fifo");
  const fifo = path.join(repo, "executor.pipe");
  execFileSync("mkfifo", [fifo]);
  const preTree = indexTree(repo);
  assert.throws(
    () => recover.__testing.stageReviewableWork(repo, Buffer.from("?? executor.pipe\0")),
    (error) => error.code === "UNSAFE_WORKTREE_ENTRY" && /executor\.pipe/.test(error.message),
  );
  assert.equal(fs.lstatSync(fifo).isFIFO(), true);
  assert.equal(indexTree(repo), preTree);
});

test("a failure after ref publication rolls back HEAD and the exact pre-call index tree", () => {
  const repo = fixture("commit-rollback");
  const target = path.join(repo, "keep.txt");
  fs.writeFileSync(target, "changed\n");
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const preTree = indexTree(repo);
  const staged = recover.__testing.stageReviewableWork(repo, status(repo));
  assert.throws(() => recover.__testing.commitVerifiedStaging(repo, staged, {
    runId: "rollback-test",
    reason: "fault injection",
    expectedHead: head,
    fault(stage) { if (stage === "after_ref_update") throw new Error("injected after ref update"); },
  }), /injected after ref update/);
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), head);
  assert.equal(indexTree(repo), preTree);
  assert.equal(fs.readFileSync(target, "utf8"), "changed\n");
});

test("a third-party HEAD move defeats ref rollback but never skips exact index rollback", () => {
  const repo = fixture("commit-ref-race");
  const target = path.join(repo, "keep.txt");
  fs.writeFileSync(target, "changed by executor\n");
  const originalHead = git(repo, ["rev-parse", "HEAD"]).trim();
  const preTree = indexTree(repo);
  const staged = recover.__testing.stageReviewableWork(repo, status(repo));
  let thirdPartyHead = null;
  assert.throws(() => recover.__testing.commitVerifiedStaging(repo, staged, {
    runId: "ref-race-test",
    reason: "fault injection",
    expectedHead: originalHead,
    fault(stage) {
      if (stage !== "after_ref_update") return;
      git(repo, ["commit", "--allow-empty", "-m", "third-party concurrent commit"]);
      thirdPartyHead = git(repo, ["rev-parse", "HEAD"]).trim();
      throw new Error("injected after third-party HEAD move");
    },
  }), (error) => {
    assert.equal(error.code, "REF_ROLLBACK_FAILED");
    assert.match(error.message, /ref rollback failed/);
    assert.equal(error instanceof AggregateError, true);
    assert.match(error.errors[0].message, /injected after third-party HEAD move/);
    return true;
  });
  assert.notEqual(thirdPartyHead, originalHead);
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), thirdPartyHead, "third-party HEAD must be preserved");
  assert.equal(indexTree(repo), preTree, "index rollback must not depend on ref rollback success");
  assert.equal(fs.readFileSync(target, "utf8"), "changed by executor\n");
});

test("simultaneous ref and index rollback failures retain the primary and both cleanup errors", () => {
  const repo = fixture("commit-double-rollback-failure");
  fs.writeFileSync(path.join(repo, "keep.txt"), "changed\n");
  const originalHead = git(repo, ["rev-parse", "HEAD"]).trim();
  const staged = recover.__testing.stageReviewableWork(repo, status(repo));
  const failingStaged = { ...staged, rollback() { throw new Error("injected index rollback failure"); } };
  assert.throws(() => recover.__testing.commitVerifiedStaging(repo, failingStaged, {
    runId: "double-rollback-test",
    reason: "fault injection",
    expectedHead: originalHead,
    fault(stage) {
      if (stage !== "after_ref_update") return;
      git(repo, ["commit", "--allow-empty", "-m", "third-party concurrent commit"]);
      throw new Error("injected primary failure");
    },
  }), (error) => {
    assert.equal(error.code, "RECOVERY_ROLLBACK_FAILED");
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.errors.length, 3);
    assert.match(error.errors[0].message, /injected primary failure/);
    assert.match(error.errors[1].message, /cannot lock ref|is at/);
    assert.match(error.errors[2].message, /injected index rollback failure/);
    return true;
  });
});
