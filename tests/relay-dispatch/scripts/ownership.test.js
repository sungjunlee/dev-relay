"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeOwnership,
  ownershipsEqual,
  parseOwnershipJson,
} = require("../../../skills/relay-dispatch/scripts/ownership");

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

test("normalizeOwnership rejects missing, opaque, extra, and malformed owner fields", () => {
  const invalid = [
    null,
    "2026-07-relay-fleet",
    { track: OWNER.track, component: OWNER.component },
    { ...OWNER, source: "fleet" },
    { ...OWNER, sprint: "../backlog/sprints/2026-07-relay-fleet.md" },
    { ...OWNER, sprint: "backlog/sprints/nested/2026-07-relay-fleet.md" },
    { ...OWNER, track: "Relay Fleet" },
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
