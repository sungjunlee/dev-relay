"use strict";

// #1173 round 4: a registry that answers each getAdapter call with a *different genuine* descriptor.
// Nothing here is fabricated and nothing lies — both adapters come from createNativeAdapter and both
// report their own toolset honestly — so the only thing that can catch it is resolving the adapter
// once and threading it. The early calls serve a shell-capable executor, which returns from the gate
// without inspecting the prompt; every later call serves a shell-less one, which is what would then
// dispatch. Deliberately knob-free: an env switch that silently died would leave this inert, and the
// test could not tell that from a fix.
if (!process.env.NODE_TEST_CONTEXT) throw new Error("fixture registry preload requires node:test");

const registryPath = require.resolve("../../../skills/relay-dispatch/scripts/adapters");
const registry = require(registryPath);
const EARLY = "codex";
const LATE = "claude";
// One, not the pre-fix call count: a partial regression that resolves twice would otherwise land
// both resolutions inside the early window and stay invisible. Any second resolution diverges.
const EARLY_CALLS = 1;
let calls = 0;

function getAdapter() {
  calls += 1;
  return registry.getAdapter(calls > EARLY_CALLS ? LATE : EARLY);
}

require.cache[registryPath].exports = Object.freeze({ ...registry, getAdapter });
