const loaders = Object.freeze({
  claude: () => require("./claude"),
  codex: () => require("./codex"),
  opencode: () => require("./opencode"),
  pi: () => require("./pi"),
  antigravity: () => require("./antigravity"),
  cursor: () => require("./cursor"),
  cline: () => require("./cline"),
});

const ADAPTER_PHASES = Object.freeze({
  DISPATCH: "dispatch",
  PRIMARY_REVIEW: "primary_review",
});

function listAdapters() {
  return Object.keys(loaders);
}

function getAdapter(name) {
  if (!Object.prototype.hasOwnProperty.call(loaders, name)) {
    throw new Error(`unknown adapter '${name}'. Supported: ${listAdapters().join(", ")}`);
  }
  return loaders[name]();
}

module.exports = {
  ADAPTER_PHASES,
  getAdapter,
  listAdapters,
};
