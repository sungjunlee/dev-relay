const MODEL_HINT_PHASES = new Set(["plan", "dispatch", "review", "merge"]);

function parseModelHints(raw) {
  if (raw === undefined) return undefined;

  const hints = {};
  const seen = new Set();
  for (const token of raw.split(",")) {
    if (!token) {
      throw new Error("invalid --model-hints token '': empty pair");
    }
    const separator = token.indexOf("=");
    if (separator === -1) {
      throw new Error(`invalid --model-hints token '${token}': missing '='`);
    }

    const phase = token.slice(0, separator).trim();
    const value = token.slice(separator + 1).trim();
    if (!phase) {
      throw new Error(`invalid --model-hints token '${token}': empty phase`);
    }
    if (!value) {
      throw new Error(`invalid --model-hints token '${token}': empty value`);
    }
    if (!MODEL_HINT_PHASES.has(phase)) {
      throw new Error(`invalid --model-hints token '${token}': unknown phase '${phase}'`);
    }
    if (seen.has(phase)) {
      throw new Error(`invalid --model-hints token '${token}': duplicate phase '${phase}'`);
    }

    seen.add(phase);
    hints[phase] = value;
  }

  return hints;
}

module.exports = { parseModelHints };
