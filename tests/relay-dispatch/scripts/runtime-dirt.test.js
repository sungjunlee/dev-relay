"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  RUNTIME_METADATA_ROOTS,
  classifyRepositoryDirt,
  gitAddReviewableArgs,
  reviewableStatusPaths,
} = require("../../../skills/relay-dispatch/scripts/runtime-dirt");
const { execGit } = require("../../../skills/relay-dispatch/scripts/exec");

const RUNTIME_DIR = RUNTIME_METADATA_ROOTS[0];
const TRACKED_RUNTIME_PATH = `${RUNTIME_DIR}/tracked-config`;

function git(repoPath, args) {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  }).trimEnd();
}

function writeFile(repoPath, relativePath, contents) {
  const absolutePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf-8");
}

function createRepository(t) {
  const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-dirt-")));
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  git(repoPath, ["init", "-b", "main"]);
  git(repoPath, ["config", "user.name", "Runtime Dirt Test"]);
  git(repoPath, ["config", "user.email", "runtime-dirt@example.com"]);
  writeFile(repoPath, TRACKED_RUNTIME_PATH, "base runtime config\n");
  writeFile(repoPath, "README.md", "base readme\n");
  writeFile(repoPath, "a.txt", "a\n");
  writeFile(repoPath, "keep.txt", "keep\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

function stagedPaths(repoPath) {
  const output = git(repoPath, ["diff", "--cached", "--name-only"]);
  return output ? output.split("\n") : [];
}

test("stages a modified tracked runtime file while excluding untracked runtime metadata", (t) => {
  const repoPath = createRepository(t);
  writeFile(repoPath, TRACKED_RUNTIME_PATH, "modified runtime config\n");
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-file`, "runtime metadata\n");

  const statusText = execGit(repoPath, ["status", "--porcelain"]);
  const dirt = classifyRepositoryDirt(statusText);
  assert.equal(dirt.hasReviewableDirt, true);
  assert.match(dirt.reviewableStatus, new RegExp(TRACKED_RUNTIME_PATH.replace(".", "\\.")));
  assert.match(dirt.runtimeMetadataStatus, /runtime-file/);

  git(repoPath, gitAddReviewableArgs(statusText, repoPath));

  assert.deepEqual(stagedPaths(repoPath), [TRACKED_RUNTIME_PATH]);
  assert.match(git(repoPath, ["status", "--porcelain"]), /runtime-file/);
});

test("stages every path classified as reviewable in a mixed status", (t) => {
  const repoPath = createRepository(t);
  writeFile(repoPath, TRACKED_RUNTIME_PATH, "modified runtime config\n");
  writeFile(repoPath, "README.md", "modified readme\n");
  writeFile(repoPath, "new reviewable.txt", "new source\n");
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-file`, "runtime metadata\n");

  const statusText = git(repoPath, ["status", "--porcelain"]);
  const dirt = classifyRepositoryDirt(statusText);
  const classifiedReviewablePaths = reviewableStatusPaths(statusText);
  assert.equal(dirt.reviewableStatus.split("\n").filter(Boolean).length, 3);

  git(repoPath, gitAddReviewableArgs(statusText, repoPath));

  const staged = new Set(stagedPaths(repoPath));
  assert.deepEqual(
    [...staged].sort(),
    [TRACKED_RUNTIME_PATH, "README.md", "new reviewable.txt"].sort(),
  );
  for (const reviewablePath of classifiedReviewablePaths) {
    assert.equal(staged.has(reviewablePath), true, `${reviewablePath} must be stageable`);
  }
});

test("excludes an untracked runtime file created after the status snapshot", (t) => {
  const repoPath = createRepository(t);
  writeFile(repoPath, TRACKED_RUNTIME_PATH, "modified runtime config\n");
  writeFile(repoPath, "README.md", "modified readme\n");
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-seen`, "seen metadata\n");

  const statusSnapshot = git(repoPath, ["status", "--porcelain"]);
  const addArgs = gitAddReviewableArgs(statusSnapshot, repoPath);
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-created-later`, "late metadata\n");

  git(repoPath, addArgs);

  assert.deepEqual(stagedPaths(repoPath).sort(), [TRACKED_RUNTIME_PATH, "README.md"].sort());
  const remainingStatus = git(repoPath, ["status", "--porcelain"]);
  assert.match(remainingStatus, /runtime-seen/);
  assert.match(remainingStatus, /runtime-created-later/);
});

test("returns plain git add arguments when there is no runtime metadata dirt", () => {
  const statusText = " M README.md\n?? new-reviewable.txt";
  assert.deepEqual(gitAddReviewableArgs(statusText), ["add", "-A"]);
});

test("classifies runtime-only dirt without reporting reviewable dirt", () => {
  const statusText = [
    `?? ${RUNTIME_DIR}/runtime-file`,
    `?? ${RUNTIME_DIR}/cache/`,
  ].join("\n");

  assert.deepEqual(classifyRepositoryDirt(statusText), {
    hasDirt: true,
    hasRuntimeMetadataDirt: true,
    hasOnlyRuntimeMetadataDirt: true,
    hasReviewableDirt: false,
    runtimeMetadataStatus: statusText,
    reviewableStatus: "",
  });
  assert.deepEqual(gitAddReviewableArgs(statusText), [
    "add",
    "-A",
    "--",
    ".",
    `:(exclude)${RUNTIME_DIR}`,
    `:(exclude)${RUNTIME_DIR}/**`,
  ]);
});

test("keeps runtime metadata roots as the only source of the runtime root literal", () => {
  assert.deepEqual(RUNTIME_METADATA_ROOTS, [".antigravitycli"]);
  assert.equal(Object.isFrozen(RUNTIME_METADATA_ROOTS), true);

  const sourcePath = path.join(
    __dirname,
    "../../../skills/relay-dispatch/scripts/runtime-dirt.js",
  );
  const source = fs.readFileSync(sourcePath, "utf-8");
  assert.equal(source.match(/\.antigravitycli/g)?.length, 1);
});

test("stages a staged rename with runtime dirt and preserves it as a rename", (t) => {
  const repoPath = createRepository(t);
  const destination = "RENAMED.md";
  git(repoPath, ["mv", "README.md", destination]);
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-file`, "runtime metadata\n");

  const statusText = execGit(repoPath, ["status", "--porcelain"]);
  const addArgs = gitAddReviewableArgs(statusText, repoPath);
  assert.deepEqual(addArgs, ["add", "-A", "--", destination]);

  git(repoPath, addArgs);

  assert.equal(
    git(repoPath, ["diff", "--cached", "--name-status"]),
    `R100\tREADME.md\t${destination}`,
  );
  git(repoPath, ["commit", "-m", "staged rename"]);
  assert.equal(
    git(repoPath, ["show", "--format=", "--name-status", "HEAD"]),
    `R100\tREADME.md\t${destination}`,
  );
  assert.match(git(repoPath, ["status", "--porcelain"]), /runtime-file/);
});

test("stages an unstaged rename with runtime dirt", (t) => {
  const repoPath = createRepository(t);
  const destination = "RENAMED.md";
  fs.renameSync(path.join(repoPath, "README.md"), path.join(repoPath, destination));
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-file`, "runtime metadata\n");

  const statusText = execGit(repoPath, ["status", "--porcelain"]);
  const addArgs = gitAddReviewableArgs(statusText, repoPath);
  assert.deepEqual(
    new Set(addArgs.slice(3)),
    new Set(["README.md", destination]),
  );

  git(repoPath, addArgs);

  assert.equal(
    git(repoPath, ["diff", "--cached", "--name-status"]),
    `R100\tREADME.md\t${destination}`,
  );
  git(repoPath, ["commit", "-m", "unstaged rename"]);
  assert.equal(
    git(repoPath, ["show", "--format=", "--name-status", "HEAD"]),
    `R100\tREADME.md\t${destination}`,
  );
  assert.match(git(repoPath, ["status", "--porcelain"]), /runtime-file/);
});

test("stages a plain deletion with runtime dirt", (t) => {
  const repoPath = createRepository(t);
  fs.unlinkSync(path.join(repoPath, "README.md"));
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-file`, "runtime metadata\n");

  const statusText = execGit(repoPath, ["status", "--porcelain"]);
  const addArgs = gitAddReviewableArgs(statusText, repoPath);
  assert.deepEqual(addArgs, ["add", "-A", "--", "README.md"]);

  git(repoPath, addArgs);

  assert.equal(
    git(repoPath, ["diff", "--cached", "--name-status"]),
    "D\tREADME.md",
  );
  assert.match(git(repoPath, ["status", "--porcelain"]), /runtime-file/);
});

test("stages a modified sibling without naming an already staged deletion", (t) => {
  const repoPath = createRepository(t);
  git(repoPath, ["rm", "a.txt"]);
  writeFile(repoPath, "keep.txt", "modified keep\n");
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-file`, "runtime metadata\n");

  const statusText = execGit(repoPath, ["status", "--porcelain"]);
  assert.match(statusText, /^D  a\.txt/m);
  assert.match(statusText, /^ M keep\.txt/m);
  const addArgs = gitAddReviewableArgs(statusText, repoPath);
  assert.deepEqual(addArgs, ["add", "-A", "--", "keep.txt"]);

  git(repoPath, addArgs);

  assert.deepEqual(
    git(repoPath, ["diff", "--cached", "--name-status"]).split("\n"),
    ["D\ta.txt", "M\tkeep.txt"],
  );
  assert.equal(stagedPaths(repoPath).includes("keep.txt"), true);
  assert.match(git(repoPath, ["status", "--porcelain"]), /runtime-file/);
});

test("stages a staged rename alongside an already staged deletion", (t) => {
  const repoPath = createRepository(t);
  const destination = "RENAMED.md";
  git(repoPath, ["mv", "README.md", destination]);
  git(repoPath, ["rm", "a.txt"]);
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-file`, "runtime metadata\n");

  const statusText = execGit(repoPath, ["status", "--porcelain"]);
  assert.match(statusText, /^D  a\.txt/m);
  assert.match(statusText, /^R  README\.md -> RENAMED\.md/m);
  const addArgs = gitAddReviewableArgs(statusText, repoPath);
  assert.deepEqual(addArgs, ["add", "-A", "--", destination]);

  git(repoPath, addArgs);

  assert.deepEqual(
    git(repoPath, ["diff", "--cached", "--name-status"]).split("\n"),
    ["R100\tREADME.md\tRENAMED.md", "D\ta.txt"],
  );
  assert.match(git(repoPath, ["status", "--porcelain"]), /runtime-file/);
});

test("emits an AD path that is absent from disk so git add records the deletion", (t) => {
  const repoPath = createRepository(t);
  const addedThenDeleted = "added-then-deleted.txt";
  writeFile(repoPath, addedThenDeleted, "temporary\n");
  git(repoPath, ["add", "--", addedThenDeleted]);
  fs.unlinkSync(path.join(repoPath, addedThenDeleted));
  writeFile(repoPath, `${RUNTIME_DIR}/runtime-file`, "runtime metadata\n");

  const statusText = execGit(repoPath, ["status", "--porcelain"]);
  assert.match(statusText, /^AD added-then-deleted\.txt/m);
  const addArgs = gitAddReviewableArgs(statusText, repoPath);
  assert.deepEqual(addArgs, ["add", "-A", "--", addedThenDeleted]);

  git(repoPath, addArgs);

  assert.deepEqual(stagedPaths(repoPath), []);
  assert.equal(
    git(repoPath, ["status", "--porcelain"]),
    `?? ${RUNTIME_DIR}/runtime-file`,
  );
});
