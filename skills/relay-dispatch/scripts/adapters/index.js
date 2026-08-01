const adapters = Object.freeze({
  claude: require("./claude"),
  codex: require("./codex"),
  opencode: require("./opencode"),
  pi: require("./pi"),
  antigravity: require("./antigravity"),
  cursor: require("./cursor"),
  cline: require("./cline"),
});
const { createGenericAdapter, validateSchema: validateGenericAdapterSchema } = require("./generic");

const ADAPTER_PHASES = Object.freeze({
  DISPATCH: "dispatch",
  PRIMARY_REVIEW: "primary_review",
});

function listAdapters() {
  return Object.keys(adapters);
}

function getAdapter(name) {
  if (!Object.prototype.hasOwnProperty.call(adapters, name)) {
    throw new Error(`unknown adapter '${name}'. Supported: ${listAdapters().join(", ")}`);
  }
  return adapters[name];
}

module.exports = {
  ADAPTER_PHASES,
  createGenericAdapter,
  getAdapter,
  listAdapters,
  validateGenericAdapterSchema,
};
