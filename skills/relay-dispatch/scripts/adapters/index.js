const adapters = Object.freeze({
  claude: require("./claude"),
  codex: require("./codex"),
  opencode: require("./opencode"),
  pi: require("./pi"),
  antigravity: require("./antigravity"),
  cursor: require("./cursor"),
  cline: require("./cline"),
});

const ADAPTER_PHASES = Object.freeze({
  DISPATCH: "dispatch",
  PRIMARY_REVIEW: "primary_review",
});

const listAdapters = () => Object.keys(adapters);

function getAdapter(name) {
  if (!Object.hasOwn(adapters, name)) {
    throw new Error(`unknown adapter '${name}'. Supported: ${listAdapters().join(", ")}`);
  }
  return adapters[name];
}

module.exports = {
  ADAPTER_PHASES,
  getAdapter,
  listAdapters,
};
