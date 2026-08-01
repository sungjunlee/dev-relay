function codexReviewArgs({ repoPath, schemaPath, resultPath, model = null }) {
  const args = [
    "exec",
    "-C", repoPath,
    "--ephemeral",
    "--sandbox", "read-only",
    "--color", "never",
    "--output-schema", schemaPath,
    "-o", resultPath,
  ];
  if (model) args.push("-m", model);
  args.push("-");
  return args;
}

function claudeReviewArgs({ schema, model = null }) {
  const args = [
    "-p",
    "--bare",
    "--no-session-persistence",
    "--output-format", "text",
    "--json-schema", JSON.stringify(schema),
    "--allowedTools=Read",
  ];
  if (model) args.push("--model", model);
  return args;
}

function cursorReviewArgs({ repoPath, model = null }) {
  const args = [
    "--print",
    "--trust",
    "--force",
    "--mode", "ask",
    "--workspace", repoPath,
    "--output-format", "json",
  ];
  if (model) args.push("--model", model);
  return args;
}

function opencodeReviewArgs({ model = null }) {
  const args = ["run"];
  if (model) args.push("-m", model);
  return args;
}

function piReviewArgs({ providerExtension = null, model = null }) {
  const args = [
    "--no-session",
    "--no-context-files",
    "--no-extensions",
    ...(providerExtension ? ["--extension", providerExtension] : []),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--tools", "read,grep,find,ls",
  ];
  if (model) args.push("--model", model);
  args.push("--print");
  return args;
}

function antigravityReviewArgs({ promptDirectory, promptReference, printTimeout }) {
  return [
    "--add-dir", promptDirectory,
    "--prompt", promptReference,
    "--print-timeout", printTimeout,
    "--sandbox",
  ];
}

module.exports = {
  antigravityReviewArgs,
  claudeReviewArgs,
  codexReviewArgs,
  cursorReviewArgs,
  opencodeReviewArgs,
  piReviewArgs,
};
