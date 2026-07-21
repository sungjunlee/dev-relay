"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeOwnership,
  ownershipsEqual,
  parseOwnershipJson,
} = require("../../../skills/relay-dispatch/scripts/ownership");
const {
  OWNER_SOURCES,
  readManifestOwnership,
} = require("../../../skills/relay-merge/scripts/sprint-owner");

const OWNER = Object.freeze({
  sprint: "backlog/sprints/2026-07-relay-fleet.md",
  track: "2026-07-relay-fleet",
  component: "relay-fleet",
});

test("normalizeOwnership returns the exact typed fleet owner", () => {
  const owner = normalizeOwnership({
    sprint: ".\\backlog\\sprints\\2026-07-relay-fleet.md",
    track: " 2026-07-relay-fleet ",
    component: " relay-fleet ",
  });

  assert.deepEqual(owner, OWNER);
  assert.equal(Object.isFrozen(owner), true);
  assert.equal(ownershipsEqual(owner, OWNER), true);
});

test("normalizeOwnership canonicalizes absolute and repo-relative sprint spellings", () => {
  const relative = normalizeOwnership(OWNER);
  const absolute = normalizeOwnership({
    ...OWNER,
    sprint: "/tmp/example-repo/backlog/sprints/2026-07-relay-fleet.md",
  });

  assert.deepEqual(relative, OWNER);
  assert.deepEqual(absolute, OWNER);
  assert.equal(ownershipsEqual(relative, absolute), true);
  assert.deepEqual(readManifestOwnership({ ownership: absolute }), {
    ...OWNER,
    source: OWNER_SOURCES.FLEET,
  });
});

test("normalizeOwnership requires track to match the sprint basename but keeps component independent", () => {
  assert.deepEqual(normalizeOwnership({
    ...OWNER,
    component: "merge-finalize",
  }), {
    ...OWNER,
    component: "merge-finalize",
  });

  assert.throws(
    () => normalizeOwnership({
      ...OWNER,
      track: "individually-valid-wrong-track",
      component: "merge-finalize",
    }),
    /ownership is contradictory: track .* must equal the sprint filename basename/
  );
});

test("normalizeOwnership rejects prefixed relative and repeated sprint markers", () => {
  for (const sprint of [
    "other/backlog/sprints/2026-07-relay-fleet.md",
    "/tmp/backlog/sprints/nested/backlog/sprints/2026-07-relay-fleet.md",
  ]) {
    assert.throws(
      () => normalizeOwnership({ ...OWNER, sprint }),
      /must identify one markdown file under backlog\/sprints\//
    );
  }
});

test("normalizeOwnership rejects missing, opaque, extra, and malformed owner fields", () => {
  const invalid = [
    null,
    "2026-07-relay-fleet",
    { track: OWNER.track, component: OWNER.component },
    { ...OWNER, source: "fleet" },
    { ...OWNER, sprint: "../backlog/sprints/2026-07-relay-fleet.md" },
    { ...OWNER, sprint: "backlog/sprints/nested/2026-07-relay-fleet.md" },
    { ...OWNER, track: "Relay Fleet" },
    { ...OWNER, track: "other-valid-track" },
    { ...OWNER, component: "relay_fleet" },
  ];

  for (const value of invalid) {
    assert.throws(() => normalizeOwnership(value), /ownership/);
  }
});

test("parseOwnershipJson fails closed for missing or malformed JSON", () => {
  assert.throws(
    () => parseOwnershipJson(undefined, { required: true }),
    /is required/
  );
  assert.throws(() => parseOwnershipJson("{bad"), /must be valid JSON/);
  assert.deepEqual(parseOwnershipJson(JSON.stringify(OWNER)), OWNER);
});
