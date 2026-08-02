"use strict";

// The checked-in fake Codex is a Node shebang script, while the supported
// production Codex install is a native executable. Model that fixture-only
// runtime dependency without widening the production adapter descriptor.
if (!process.env.NODE_TEST_CONTEXT) throw new Error("fixture adapter preload requires node:test");

const registryPath = require.resolve("../../../skills/relay-dispatch/scripts/adapters");
const registry = require(registryPath);
const runtimeDependencies = Object.freeze({ executableParent: null, interpreterParent: 1 });
let fixtureCodex = null;

function getAdapter(name) {
  const adapter = registry.getAdapter(name);
  if (name !== "codex") return adapter;
  if (!fixtureCodex) {
    fixtureCodex = Object.freeze({
      ...adapter,
      metadata: Object.freeze({ ...adapter.metadata, runtimeDependencies }),
      buildInvocation(options) {
        return Object.freeze({ ...adapter.buildInvocation(options), runtimeDependencies });
      },
    });
  }
  return fixtureCodex;
}

require.cache[registryPath].exports = Object.freeze({ ...registry, getAdapter });
