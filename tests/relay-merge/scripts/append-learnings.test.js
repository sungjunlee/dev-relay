const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATUS,
  parseArgs,
  parseFrontmatter,
  readFrontmatterField,
  parseComponents,
  findActiveSprint,
  findCapabilityBlock,
  locateMarkers,
  buildEntry,
  appendLearningsCore,
  appendLearnings,
  formatHumanReport,
} = require("../../../skills/relay-merge/scripts/append-learnings.js");

const SAMPLE_CAPABILITIES = `# Project Capabilities

## Capability: auth
**Goal:** something

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |

---

## Capability: billing
**Goal:** something else

### Learnings
<!-- LEARN:BEGIN -->
- 2026-04-01 (run #001): seed entry [PR #1]
<!-- LEARN:END -->

### Decisions
| date | decision | rationale | supersedes |
| --- | --- | --- | --- |
`;

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "append-learnings-"));
}

function seedFixture(repo, { activeComponent = "auth", capabilities = SAMPLE_CAPABILITIES, sprintExtras = "" } = {}) {
  fs.mkdirSync(path.join(repo, "spec"), { recursive: true });
  fs.mkdirSync(path.join(repo, "backlog", "sprints"), { recursive: true });
  fs.writeFileSync(path.join(repo, "spec", "capabilities.md"), capabilities);
  const sprintBody = `---
milestone: x
status: active
started: 2026-05-23
due: TBD
objectives: []
component: "${activeComponent}"
${sprintExtras}---

# Sprint
`;
  fs.writeFileSync(path.join(repo, "backlog", "sprints", "2026-05-x.md"), sprintBody);
}

describe("parseArgs", () => {
  it("requires --repo, --run-id, --pr", () => {
    assert.match(parseArgs([]).error, /Missing --repo/);
    assert.match(parseArgs(["--repo", "."]).error, /Missing --run-id/);
    assert.match(parseArgs(["--repo", ".", "--run-id", "r"]).error, /Missing --pr/);
  });

  it("parses required + optional flags", () => {
    const parsed = parseArgs([
      "--repo", "/x", "--run-id", "r1", "--pr", "42",
      "--synthesis", "did the thing", "--date", "2026-05-23",
      "--dry-run", "--json",
    ]);
    assert.equal(parsed.repo, "/x");
    assert.equal(parsed.runId, "r1");
    assert.equal(parsed.pr, "42");
    assert.equal(parsed.synthesis, "did the thing");
    assert.equal(parsed.date, "2026-05-23");
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.json, true);
  });

  it("accepts the = form", () => {
    const parsed = parseArgs(["--repo=/x", "--run-id=r1", "--pr=42"]);
    assert.equal(parsed.repo, "/x");
    assert.equal(parsed.runId, "r1");
    assert.equal(parsed.pr, "42");
  });

  it("errors on unknown argument", () => {
    assert.match(parseArgs(["--repo", "/x", "--run-id", "r", "--pr", "1", "--bogus"]).error, /Unknown argument/);
  });
});

describe("parseFrontmatter / readFrontmatterField", () => {
  it("extracts simple fields", () => {
    const fm = parseFrontmatter("---\ncomponent: \"auth\"\nstatus: active\n---\nbody");
    assert.equal(readFrontmatterField(fm, "component"), "auth");
    assert.equal(readFrontmatterField(fm, "status"), "active");
  });

  it("strips quotes (single + double)", () => {
    assert.equal(readFrontmatterField("component: 'auth'", "component"), "auth");
    assert.equal(readFrontmatterField('component: "auth"', "component"), "auth");
  });

  it("returns null when field absent", () => {
    assert.equal(readFrontmatterField("milestone: x", "component"), null);
  });
});

describe("parseComponents", () => {
  it("splits comma-separated multi", () => {
    assert.deepEqual(parseComponents("a, b , c"), ["a", "b", "c"]);
  });

  it("handles empty / null", () => {
    assert.deepEqual(parseComponents(""), []);
    assert.deepEqual(parseComponents(null), []);
  });

  it("returns single-element list for one value", () => {
    assert.deepEqual(parseComponents("auth"), ["auth"]);
  });
});

describe("findActiveSprint", () => {
  it("returns the one sprint with status: active", () => {
    const repo = makeRepo();
    try {
      const dir = path.join(repo, "backlog", "sprints");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "a.md"), "---\nstatus: completed\n---\n");
      fs.writeFileSync(path.join(dir, "b.md"), "---\nstatus: active\n---\n");
      const result = findActiveSprint(dir);
      assert.ok(result);
      assert.ok(result.file.endsWith("b.md"));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null when no active sprint", () => {
    const repo = makeRepo();
    try {
      const dir = path.join(repo, "backlog", "sprints");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "a.md"), "---\nstatus: completed\n---\n");
      assert.equal(findActiveSprint(dir), null);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null when sprints dir is missing", () => {
    assert.equal(findActiveSprint("/no/such/dir"), null);
  });
});

describe("findCapabilityBlock", () => {
  it("locates the matching block bounded by next ## Capability or EOF", () => {
    const block = findCapabilityBlock(SAMPLE_CAPABILITIES, "auth");
    assert.ok(block);
    assert.ok(block.start >= 0);
    assert.ok(block.end > block.start);
    const text = block.lines.slice(block.start, block.end).join("\n");
    assert.match(text, /## Capability: auth/);
    assert.ok(!/## Capability: billing/.test(text));
  });

  it("returns null for unknown capability", () => {
    assert.equal(findCapabilityBlock(SAMPLE_CAPABILITIES, "ghost"), null);
  });
});

describe("locateMarkers", () => {
  it("finds BEGIN and END markers within block", () => {
    const block = findCapabilityBlock(SAMPLE_CAPABILITIES, "auth");
    const blockLines = block.lines.slice(block.start, block.end);
    const m = locateMarkers(blockLines, block.start);
    assert.ok(m.beginIdx >= block.start);
    assert.ok(m.endIdx > m.beginIdx);
  });

  it("returns -1 when markers absent", () => {
    const lines = ["## Capability: solo", "no markers here"];
    const m = locateMarkers(lines, 0);
    assert.equal(m.beginIdx, -1);
    assert.equal(m.endIdx, -1);
  });
});

describe("buildEntry", () => {
  it("renders the schema-bound format", () => {
    const entry = buildEntry({ date: "2026-05-23", runId: "r1", synthesis: "did it", pr: "42" });
    assert.equal(entry, "- 2026-05-23 (run #r1): did it [PR #42]");
  });

  it("falls back to a synthesis stub when none provided", () => {
    const entry = buildEntry({ date: "2026-05-23", runId: "r1", synthesis: null, pr: "42" });
    assert.match(entry, /relay-merge of PR #42/);
  });
});

describe("appendLearningsCore — fixture-driven", () => {
  it("happy path appends inside markers", () => {
    const result = appendLearningsCore({
      capabilitiesContent: SAMPLE_CAPABILITIES,
      primaryComponent: "auth",
      secondaryComponents: [],
      runId: "r2",
      pr: "99",
      synthesis: "added retry policy",
      date: "2026-05-23",
    });
    assert.equal(result.status, STATUS.APPENDED);
    assert.match(result.entry, /run #r2.*PR #99/);
    const beginIdx = result.updatedContent.indexOf("<!-- LEARN:BEGIN -->");
    const entryIdx = result.updatedContent.indexOf(result.entry);
    const endIdx = result.updatedContent.indexOf("<!-- LEARN:END -->");
    assert.ok(beginIdx < entryIdx && entryIdx < endIdx, "entry must sit between markers");
  });

  it("idempotent: same run-id is a no-op skip", () => {
    const result = appendLearningsCore({
      capabilitiesContent: SAMPLE_CAPABILITIES,
      primaryComponent: "billing",
      secondaryComponents: [],
      runId: "001", // already seeded under billing
      pr: "1",
      synthesis: "duplicate attempt",
      date: "2026-05-23",
    });
    assert.equal(result.status, STATUS.SKIPPED);
    assert.equal(result.reason, "idempotent_match");
  });

  it("unmatched component is a skip, not a failure", () => {
    const result = appendLearningsCore({
      capabilitiesContent: SAMPLE_CAPABILITIES,
      primaryComponent: "ghost",
      secondaryComponents: [],
      runId: "r3",
      pr: "10",
      synthesis: null,
      date: "2026-05-23",
    });
    assert.equal(result.status, STATUS.SKIPPED);
    assert.equal(result.reason, "component_not_found");
  });

  it("multi-component records a D4 warning for secondary entries", () => {
    const result = appendLearningsCore({
      capabilitiesContent: SAMPLE_CAPABILITIES,
      primaryComponent: "auth",
      secondaryComponents: ["billing"],
      runId: "r4",
      pr: "11",
      synthesis: "multi",
      date: "2026-05-23",
    });
    assert.equal(result.status, STATUS.APPENDED);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].kind, "secondary_components_ignored");
    assert.match(result.warnings[0].detail, /billing/);
  });

  it("tampered: BEGIN marker missing → failure (not silent)", () => {
    const tampered = SAMPLE_CAPABILITIES.replace("<!-- LEARN:BEGIN -->\n", "");
    const result = appendLearningsCore({
      capabilitiesContent: tampered,
      primaryComponent: "auth",
      secondaryComponents: [],
      runId: "r5",
      pr: "12",
      synthesis: null,
      date: "2026-05-23",
    });
    assert.equal(result.status, STATUS.FAILED);
    assert.equal(result.reason, "markers_missing");
  });

  it("tampered: END before BEGIN → markers_tampered", () => {
    const swapped = SAMPLE_CAPABILITIES.replace(
      /<!-- LEARN:BEGIN -->\n<!-- LEARN:END -->/,
      "<!-- LEARN:END -->\n<!-- LEARN:BEGIN -->",
    );
    const result = appendLearningsCore({
      capabilitiesContent: swapped,
      primaryComponent: "auth",
      secondaryComponents: [],
      runId: "r6",
      pr: "13",
      synthesis: null,
      date: "2026-05-23",
    });
    assert.equal(result.status, STATUS.FAILED);
    assert.equal(result.reason, "markers_tampered");
  });
});

describe("appendLearnings — end-to-end with fs", () => {
  it("happy path writes capabilities.md", () => {
    const repo = makeRepo();
    try {
      seedFixture(repo, { activeComponent: "auth" });
      const result = appendLearnings({
        repo, runId: "rE1", pr: "501", synthesis: "e2e happy", date: "2026-05-23",
      });
      assert.equal(result.status, STATUS.APPENDED);
      const written = fs.readFileSync(path.join(repo, "spec", "capabilities.md"), "utf-8");
      assert.match(written, /run #rE1.*PR #501/);
      assert.match(written, /e2e happy/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("dry-run does not write but reports appended", () => {
    const repo = makeRepo();
    try {
      seedFixture(repo, { activeComponent: "auth" });
      const original = fs.readFileSync(path.join(repo, "spec", "capabilities.md"), "utf-8");
      const result = appendLearnings({
        repo, runId: "rE2", pr: "502", synthesis: "dry", date: "2026-05-23", dryRun: true,
      });
      assert.equal(result.status, STATUS.APPENDED);
      const after = fs.readFileSync(path.join(repo, "spec", "capabilities.md"), "utf-8");
      assert.equal(after, original);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("missing capabilities.md → skipped, exit 0 path", () => {
    const repo = makeRepo();
    try {
      // no spec/, no sprints/
      const result = appendLearnings({
        repo, runId: "rE3", pr: "503",
      });
      assert.equal(result.status, STATUS.SKIPPED);
      assert.equal(result.reason, "capabilities_absent");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("no active sprint → skipped", () => {
    const repo = makeRepo();
    try {
      fs.mkdirSync(path.join(repo, "spec"), { recursive: true });
      fs.writeFileSync(path.join(repo, "spec", "capabilities.md"), SAMPLE_CAPABILITIES);
      const result = appendLearnings({ repo, runId: "rE4", pr: "504" });
      assert.equal(result.status, STATUS.SKIPPED);
      assert.equal(result.reason, "active_sprint_absent");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("empty component: → skipped (no live-update target)", () => {
    const repo = makeRepo();
    try {
      seedFixture(repo, { activeComponent: "" });
      const result = appendLearnings({ repo, runId: "rE5", pr: "505" });
      assert.equal(result.status, STATUS.SKIPPED);
      assert.equal(result.reason, "component_empty");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("idempotent across invocations: re-running adds nothing", () => {
    const repo = makeRepo();
    try {
      seedFixture(repo, { activeComponent: "auth" });
      const first = appendLearnings({ repo, runId: "rIdem", pr: "601", synthesis: "first", date: "2026-05-23" });
      assert.equal(first.status, STATUS.APPENDED);
      const writtenAfterFirst = fs.readFileSync(path.join(repo, "spec", "capabilities.md"), "utf-8");
      const second = appendLearnings({ repo, runId: "rIdem", pr: "601", synthesis: "first", date: "2026-05-23" });
      assert.equal(second.status, STATUS.SKIPPED);
      assert.equal(second.reason, "idempotent_match");
      const writtenAfterSecond = fs.readFileSync(path.join(repo, "spec", "capabilities.md"), "utf-8");
      assert.equal(writtenAfterFirst, writtenAfterSecond);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("formatHumanReport", () => {
  it("renders the appended path", () => {
    const out = formatHumanReport({
      status: STATUS.APPENDED,
      capabilitiesPath: "/x/spec/capabilities.md",
      primaryComponent: "auth",
      entry: "- 2026-05-23 (run #r1): did it [PR #42]",
      warnings: [],
    });
    assert.match(out, /Appended/);
    assert.match(out, /did it/);
  });

  it("renders skip and failed paths", () => {
    assert.match(formatHumanReport({ status: STATUS.SKIPPED, reason: "component_empty" }), /skipped/);
    assert.match(formatHumanReport({ status: STATUS.FAILED, reason: "markers_missing" }), /failed/);
  });
});
