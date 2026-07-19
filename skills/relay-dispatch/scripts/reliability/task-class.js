const TASK_CLASSES = Object.freeze([
  "code", "design", "documentation", "operations_security", "data_change",
]);

function normalizedText(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
    : null;
}

function taskClassFor(profile = {}) {
  const explicit = normalizedText(profile.task_class);
  if (TASK_CLASSES.includes(explicit)) return explicit;
  const tokens = [
    profile.change_type,
    ...(profile.domains || []),
    ...(profile.risk_tags || []),
    ...(profile.guidance_packs || []),
  ].map(normalizedText).filter(Boolean).join(" ");
  if (/(design|ui|ux|visual)/.test(tokens)) return "design";
  if (/(docs|documentation|reader)/.test(tokens)) return "documentation";
  if (/(data|database|migration|persistent)/.test(tokens)) return "data_change";
  if (/(operations|ops|infra|security|deployment|trust_boundary)/.test(tokens)) {
    return "operations_security";
  }
  if (/(code|feature|bug|refactor|test)/.test(tokens)) return "code";
  return "unknown";
}

module.exports = {
  normalizedText,
  taskClassFor,
  TASK_CLASSES,
};
