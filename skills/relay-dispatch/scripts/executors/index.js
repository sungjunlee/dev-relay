const codex = require("./codex");
const claude = require("./claude");
const opencode = require("./opencode");

const EXECUTORS = { codex, claude, opencode };

function getExecutor(name) {
  if (!Object.prototype.hasOwnProperty.call(EXECUTORS, name)) {
    throw new Error(`unknown executor '${name}'. Supported: ${Object.keys(EXECUTORS).join(", ")}`);
  }
  return EXECUTORS[name];
}

function listExecutors() {
  return Object.keys(EXECUTORS);
}

module.exports = { getExecutor, listExecutors };
