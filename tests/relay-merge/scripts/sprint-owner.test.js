const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  OWNER_SOURCES,
  parseIssueComponent,
  readManifestOwnership,
  validateSprintStatePayload,
  invokeSprintState,
  normalizeRepoSprintPath,
  resolveSprintOwner,
  discoverSprintStateBin,
  resolveFromSprintFile,
} = require("../../../skills/relay-merge/scripts/sprint-owner.js");

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sprint-owner-"));
}

function writeSprint(repo, name, { status = "active", component }) {
  const dir = path.join(repo, "backlog", "sprints");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---
status: ${status}
component: "${component}"
---

# ${name}
`);
  return file;
}

describe("parseIssueComponent", () => {
  it("reads a leading structured component metadata line", () => {
    assert.equal(
      parseIssueComponent("component: merge-finalize\n\nPart of #954."),
      "merge-finalize"
    );
  });

  it("ignores incidental prose mentions of component:", () => {
    assert.equal(
      parseIssueComponent("Please set the component: merge-finalize in docs.\n"),
      null
    );
  });

  it("stops at headings before scanning prose", () => {
    assert.equal(
      parseIssueComponent("# Title\ncomponent: merge-finalize\n"),
      null
    );
  });
});

describe("readManifestOwnership", () => {
  it("reads the fleet ownership seam", () => {
    assert.deepEqual(
      readManifestOwnership({
        ownership: { track: "auth-track", component: "auth" },
      }),
      {
        sprint: null,
        track: "auth-track",
        component: "auth",
        source: OWNER_SOURCES.FLEET,
      }
    );
  });
});

describe("normalizeRepoSprintPath", () => {
  it("resolves relative backlog/sprints paths against the repo, not cwd", () => {
    const repo = makeRepo();
    const previous = process.cwd();
    try {
      const sprint = writeSprint(repo, "2026-07-auth", { component: "auth" });
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "sprint-cwd-"));
      process.chdir(other);
      const result = normalizeRepoSprintPath(repo, "backlog/sprints/2026-07-auth.md");
      assert.equal(result.ok, true);
      assert.equal(result.sprintPath, sprint);
    } finally {
      process.chdir(previous);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects paths that escape backlog/sprints", () => {
    const repo = makeRepo();
    try {
      writeSprint(repo, "2026-07-auth", { component: "auth" });
      fs.writeFileSync(path.join(repo, "README.md"), "escape target\n");
      const escaped = normalizeRepoSprintPath(repo, "backlog/sprints/../../README.md");
      assert.equal(escaped.ok, false);
      assert.equal(escaped.reason, "sprint_path_escaped");
      const absEscape = normalizeRepoSprintPath(repo, "/tmp/evil.md");
      assert.equal(absEscape.ok, false);
      assert.ok(["sprint_path_escaped", "sprint_path_missing"].includes(absEscape.reason));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("validateSprintStatePayload", () => {
  it("accepts schema_version >= 2 with a single active_sprint", () => {
    const result = validateSprintStatePayload({
      schema_version: 2,
      active_sprint: {
        path: "/repo/backlog/sprints/auth.md",
        frontmatter: { component: "auth" },
      },
    }, { component: "auth" });
    assert.equal(result.ok, true);
    assert.equal(result.component, "auth");
    assert.equal(result.track, "auth");
  });

  it("rejects schema_version 1", () => {
    const result = validateSprintStatePayload({
      schema_version: 1,
      active_sprint: {
        path: "/repo/backlog/sprints/auth.md",
        frontmatter: { component: "auth" },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "sprint_state_unsupported_schema");
  });

  it("rejects unresolved selector payloads", () => {
    const result = validateSprintStatePayload({
      schema_version: 2,
      active_sprint: null,
      active_sprints: [{ active_sprint: { path: "a.md" } }, { active_sprint: { path: "b.md" } }],
    }, { component: "auth" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "sprint_state_unresolved");
    assert.match(result.detail, /no single active_sprint/);
  });

  it("rejects non-object JSON payloads with an actionable reason", () => {
    const asArray = validateSprintStatePayload([1, 2], { component: "auth" });
    assert.equal(asArray.ok, false);
    assert.equal(asArray.reason, "sprint_state_invalid");
    assert.match(asArray.detail, /not an object/);

    const asNull = validateSprintStatePayload(null, { component: "auth" });
    assert.equal(asNull.ok, false);
    assert.equal(asNull.reason, "sprint_state_invalid");
  });

  it("rejects empty and multiple components from sprint-state frontmatter", () => {
    const empty = validateSprintStatePayload({
      schema_version: 2,
      active_sprint: {
        path: "/repo/backlog/sprints/auth.md",
        frontmatter: { component: "" },
      },
    }, { component: "auth" });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "component_empty");
    assert.match(empty.detail, /empty\/missing component/);

    const multi = validateSprintStatePayload({
      schema_version: 2,
      active_sprint: {
        path: "/repo/backlog/sprints/auth.md",
        frontmatter: { component: "auth, billing" },
      },
    }, { component: "auth" });
    assert.equal(multi.ok, false);
    assert.equal(multi.reason, "multiple_components");
    assert.deepEqual(multi.components, ["auth", "billing"]);
  });

  it("validates --track against the returned track, not basename alone", () => {
    const mismatch = validateSprintStatePayload({
      schema_version: 2,
      active_sprint: {
        path: "/repo/backlog/sprints/2026-07-auth.md",
        frontmatter: { component: "auth" },
      },
    }, { track: "totally-unrelated" });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, "contradictory_owner");
    assert.match(mismatch.detail, /track selector/);
  });
});

describe("invokeSprintState", () => {
  it("surfaces malformed JSON with sprint_state_invalid", () => {
    const result = invokeSprintState({
      binPath: "/fake/sprint-state.js",
      backlogDir: "/repo/backlog",
      component: "auth",
      execFileSyncFn: () => "not-json{{{",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "sprint_state_invalid");
    assert.match(result.detail, /JSON parse failed/);
  });

  it("surfaces non-object JSON and ambiguous unresolved selection", () => {
    const nonObject = invokeSprintState({
      binPath: "/fake/sprint-state.js",
      backlogDir: "/repo/backlog",
      component: "auth",
      execFileSyncFn: () => JSON.stringify(["nope"]),
    });
    assert.equal(nonObject.ok, false);
    assert.equal(nonObject.reason, "sprint_state_invalid");
    assert.match(nonObject.detail, /not an object/);

    const unresolved = invokeSprintState({
      binPath: "/fake/sprint-state.js",
      backlogDir: "/repo/backlog",
      track: "missing",
      execFileSyncFn: () => JSON.stringify({
        schema_version: 2,
        active_sprint: null,
        active_sprints: [],
      }),
    });
    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.reason, "sprint_state_unresolved");
  });
});

describe("resolveSprintOwner", () => {
  it("resolves an explicit sprint path without sprint-state", () => {
    const repo = makeRepo();
    try {
      const sprint = writeSprint(repo, "2026-07-auth", { component: "auth" });
      const result = resolveSprintOwner({
        repo,
        sprint,
        sprintState: () => assert.fail("sprint-state must not be called"),
      });
      assert.equal(result.ok, true);
      assert.equal(result.component, "auth");
      assert.equal(result.source, OWNER_SOURCES.EXPLICIT_SPRINT);
      assert.equal(result.sprintPath, sprint);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("resolves explicit component via injectable sprint-state", () => {
    const repo = makeRepo();
    try {
      const sprint = writeSprint(repo, "2026-07-auth", { component: "auth" });
      writeSprint(repo, "2026-07-billing", { component: "billing" });
      const result = resolveSprintOwner({
        repo,
        component: "billing",
        sprintState: ({ component }) => {
          assert.equal(component, "billing");
          return {
            ok: true,
            sprintPath: path.join(repo, "backlog", "sprints", "2026-07-billing.md"),
            track: "2026-07-billing",
            component: "billing",
            source: OWNER_SOURCES.EXPLICIT_COMPONENT,
            schemaVersion: 2,
          };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.component, "billing");
      assert.equal(result.track, "2026-07-billing");
      assert.notEqual(result.sprintPath, sprint);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("derives standalone issue component and prefers it over multi-active ambiguity", () => {
    const repo = makeRepo();
    try {
      writeSprint(repo, "2026-07-auth", { component: "auth" });
      writeSprint(repo, "2026-07-merge", { component: "merge-finalize" });
      const result = resolveSprintOwner({
        repo,
        issueBody: "component: merge-finalize\n\nBody text mentions component: auth by accident.",
        sprintState: ({ component }) => ({
          ok: true,
          sprintPath: path.join(repo, "backlog", "sprints", "2026-07-merge.md"),
          track: "2026-07-merge",
          component,
          source: OWNER_SOURCES.EXPLICIT_COMPONENT,
          schemaVersion: 2,
        }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.component, "merge-finalize");
      assert.equal(result.source, OWNER_SOURCES.ISSUE_COMPONENT);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("accepts fleet ownership injection", () => {
    const repo = makeRepo();
    try {
      writeSprint(repo, "2026-07-auth", { component: "auth" });
      const result = resolveSprintOwner({
        repo,
        owner: {
          component: "auth",
          track: "2026-07-auth",
          source: OWNER_SOURCES.FLEET,
        },
        sprintState: ({ component }) => ({
          ok: true,
          sprintPath: path.join(repo, "backlog", "sprints", "2026-07-auth.md"),
          track: "2026-07-auth",
          component,
          source: OWNER_SOURCES.EXPLICIT_COMPONENT,
          schemaVersion: 2,
        }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.source, OWNER_SOURCES.FLEET);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps single-active fallback with no owner input", () => {
    const repo = makeRepo();
    try {
      const sprint = writeSprint(repo, "2026-07-only", { component: "auth" });
      const result = resolveSprintOwner({
        repo,
        sprintState: () => assert.fail("sprint-state must not be called for N==1 fallback"),
      });
      assert.equal(result.ok, true);
      assert.equal(result.source, OWNER_SOURCES.SINGLE_ACTIVE);
      assert.equal(result.sprintPath, sprint);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns multiple_active_sprints only when unresolved", () => {
    const repo = makeRepo();
    try {
      writeSprint(repo, "2026-07-auth", { component: "auth" });
      writeSprint(repo, "2026-07-billing", { component: "billing" });
      const result = resolveSprintOwner({
        repo,
        sprintState: () => assert.fail("should not call sprint-state without selector"),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "multiple_active_sprints");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects contradictory CLI track+component", () => {
    const repo = makeRepo();
    try {
      writeSprint(repo, "2026-07-auth", { component: "auth" });
      const result = resolveSprintOwner({
        repo,
        track: "2026-07-auth",
        component: "billing",
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "contradictory_owner");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects contradictory fleet track vs resolved component", () => {
    const repo = makeRepo();
    try {
      writeSprint(repo, "2026-07-auth", { component: "auth" });
      const result = resolveSprintOwner({
        repo,
        owner: {
          component: "auth",
          track: "wrong-track",
          source: OWNER_SOURCES.FLEET,
        },
        sprintState: ({ component }) => ({
          ok: true,
          sprintPath: path.join(repo, "backlog", "sprints", "2026-07-auth.md"),
          track: "2026-07-auth",
          component,
          source: OWNER_SOURCES.EXPLICIT_COMPONENT,
          schemaVersion: 2,
        }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "contradictory_owner");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("surfaces sprint_state_unavailable from discovery", () => {
    const result = discoverSprintStateBin({
      env: {},
      homedir: () => "/tmp/no-such-home-for-sprint-state",
      existsSync: () => false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "sprint_state_unavailable");
  });

  it("rejects a sprint file whose component contradicts expectedComponent", () => {
    const repo = makeRepo();
    try {
      const sprint = writeSprint(repo, "2026-07-auth", { component: "auth" });
      const result = resolveFromSprintFile(sprint, {
        source: OWNER_SOURCES.EXPLICIT_SPRINT,
        repo,
        expectedComponent: "billing",
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "contradictory_owner");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("caller CLI component overrides a contradictory fleet owner wholesale", () => {
    const repo = makeRepo();
    try {
      writeSprint(repo, "2026-07-auth", { component: "auth" });
      writeSprint(repo, "2026-07-billing", { component: "billing" });
      const result = resolveSprintOwner({
        repo,
        component: "billing",
        owner: {
          component: "auth",
          track: "2026-07-auth",
          source: OWNER_SOURCES.FLEET,
        },
        sprintState: ({ component, track }) => {
          assert.equal(component, "billing");
          assert.equal(track, undefined);
          return {
            ok: true,
            sprintPath: path.join(repo, "backlog", "sprints", "2026-07-billing.md"),
            track: "2026-07-billing",
            component: "billing",
            source: OWNER_SOURCES.EXPLICIT_COMPONENT,
            schemaVersion: 2,
          };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.component, "billing");
      assert.equal(result.source, OWNER_SOURCES.EXPLICIT_COMPONENT);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("relative sprint path works when process cwd differs from the repo", () => {
    const repo = makeRepo();
    const previous = process.cwd();
    try {
      writeSprint(repo, "2026-07-auth", { component: "auth" });
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "owner-cwd-"));
      process.chdir(other);
      const result = resolveSprintOwner({
        repo,
        sprint: "backlog/sprints/2026-07-auth.md",
        sprintState: () => assert.fail("sprint-state must not be called"),
      });
      assert.equal(result.ok, true);
      assert.equal(result.component, "auth");
      assert.equal(result.sprintPath, path.join(repo, "backlog", "sprints", "2026-07-auth.md"));
    } finally {
      process.chdir(previous);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
