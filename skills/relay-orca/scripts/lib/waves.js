"use strict";

const { reject } = require("./reasons");

// Resolve and validate each outcome's depends_on edges against the declared id set.
function edgesFor(outcomes) {
  const ids = new Set(outcomes.map((outcome) => outcome.id));
  const edges = new Map();
  outcomes.forEach((outcome) => {
    const deps = Array.isArray(outcome.depends_on) ? outcome.depends_on : [];
    deps.forEach((dep) => {
      if (!ids.has(dep)) {
        reject("UNKNOWN_DEPENDENCY", `outcome ${outcome.id} depends on unknown outcome ${JSON.stringify(dep)}`);
      }
      if (dep === outcome.id) {
        reject("DEPENDENCY_CYCLE", `outcome ${outcome.id} depends on itself`);
      }
    });
    edges.set(outcome.id, deps);
  });
  return edges;
}

// Longest-path leveling; a re-entered node on the active DFS stack is a cycle (D7d).
function computeLevels(outcomes, edges) {
  const level = new Map();
  const active = new Set();
  const visit = (id) => {
    if (level.has(id)) return level.get(id);
    if (active.has(id)) {
      reject("DEPENDENCY_CYCLE", `dependency cycle detected at outcome ${id}`);
    }
    active.add(id);
    let lvl = 0;
    for (const dep of edges.get(id)) lvl = Math.max(lvl, visit(dep) + 1);
    active.delete(id);
    level.set(id, lvl);
    return lvl;
  };
  outcomes.forEach((outcome) => visit(outcome.id));
  return level;
}

// Author-declared waves: all-or-nothing positive integers. Every dependency must
// resolve to a strictly earlier declared wave, otherwise it is a same-wave (or
// out-of-order) dependency (D7e).
function declaredLevels(outcomes, edges) {
  const declared = outcomes.filter((outcome) => outcome.wave !== undefined);
  if (declared.length === 0) return null;
  if (declared.length !== outcomes.length) {
    reject("INVALID_WAVE_DECLARATION", "wave declarations must be all-or-nothing across outcomes");
  }
  const wave = new Map();
  outcomes.forEach((outcome) => {
    if (!Number.isInteger(outcome.wave) || outcome.wave < 1) {
      reject("INVALID_WAVE_DECLARATION", `outcome ${outcome.id} has invalid wave ${JSON.stringify(outcome.wave)} (expected integer >= 1)`);
    }
    wave.set(outcome.id, outcome.wave);
  });
  outcomes.forEach((outcome) => {
    for (const dep of edges.get(outcome.id)) {
      if (wave.get(dep) >= wave.get(outcome.id)) {
        reject("SAME_WAVE_DEPENDENCY", `outcome ${outcome.id} (wave ${wave.get(outcome.id)}) depends on ${dep} (wave ${wave.get(dep)}); dependencies must resolve to a strictly earlier wave`);
      }
    }
  });
  return wave;
}

// Group outcome ids into ordered, contiguous waves. keyOf maps an outcome id to
// its raw level/declared value; groups are sorted ascending then re-indexed 1..k.
function groupIntoWaves(outcomes, keyOf, taskIdOf) {
  const buckets = new Map();
  outcomes.forEach((outcome) => {
    const key = keyOf(outcome.id);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(taskIdOf(outcome.id));
  });
  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((key, index) => ({ wave: index + 1, task_ids: buckets.get(key).slice().sort() }));
}

module.exports = { edgesFor, computeLevels, declaredLevels, groupIntoWaves };
