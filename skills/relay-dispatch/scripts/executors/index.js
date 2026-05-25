const {
  ADAPTER_PHASES,
  getAgentAdapterDescriptor,
  listAgentAdapterNames,
  supportsAgentAdapterPhase,
} = require("../agent-adapters");

const EXECUTOR_COMPAT_ORDER = ["codex", "claude", "opencode"];

function listExecutors() {
  const names = listAgentAdapterNames();
  return [
    ...EXECUTOR_COMPAT_ORDER.filter((name) => (
      names.includes(name) && supportsAgentAdapterPhase(name, ADAPTER_PHASES.DISPATCH)
    )),
    ...names.filter((name) => (
      !EXECUTOR_COMPAT_ORDER.includes(name)
      && supportsAgentAdapterPhase(name, ADAPTER_PHASES.DISPATCH)
    )),
  ];
}

function getExecutor(name) {
  const executors = listExecutors();
  if (!executors.includes(name)) {
    throw new Error(`unknown executor '${name}'. Supported: ${executors.join(", ")}`);
  }
  return getAgentAdapterDescriptor(name).executor;
}

module.exports = { getExecutor, listExecutors };
