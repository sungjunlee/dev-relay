function formatModeLabel(flag, cliArgOptions) {
  if (!cliArgOptions || !Array.isArray(cliArgOptions.reservedFlags) || !Array.isArray(cliArgOptions.booleanFlags)) {
    throw new Error("printUsage requires caller-local CLI argument options");
  }
  if (!cliArgOptions.reservedFlags.includes(flag)) throw new Error(`unreserved CLI flag: ${flag}`);
  return cliArgOptions.booleanFlags.includes(flag) ? "[boolean]" : "[value]";
}

function printUsage(cliArgOptions) {
  console.log("Usage: review-runner.js --repo <path> (--run-id <id> | --branch <name> | --pr <number>) [options]");
  console.log("\nPrepare or apply a structured relay review round.");
  console.log("\nOptions:");
  console.log(`  --repo <path>                ${formatModeLabel("--repo", cliArgOptions)} Repository root (default: .)`);
  console.log(`  --run-id <id>                ${formatModeLabel("--run-id", cliArgOptions)} Relay run identifier`);
  console.log(`  --branch <name>              ${formatModeLabel("--branch", cliArgOptions)} Working branch`);
  console.log(`  --pr <number>                ${formatModeLabel("--pr", cliArgOptions)} PR number`);
  console.log(`  --manifest <path>            ${formatModeLabel("--manifest", cliArgOptions)} Explicit manifest path`);
  console.log(`  --done-criteria-file <path>  ${formatModeLabel("--done-criteria-file", cliArgOptions)} Use fixture file instead of gh issue fetch`);
  console.log(`  --diff-file <path>           ${formatModeLabel("--diff-file", cliArgOptions)} Use fixture file instead of gh pr diff`);
  console.log(`  --review-file <path>         ${formatModeLabel("--review-file", cliArgOptions)} Structured reviewer JSON verdict to apply`);
  console.log(`  --manual-review-reason <text> ${formatModeLabel("--manual-review-reason", cliArgOptions)} Audit reason for an operator-supplied manual verdict`);
  console.log(`  --reviewer <name>            ${formatModeLabel("--reviewer", cliArgOptions)} Reviewer adapter to invoke (codex|claude|...)`);
  console.log(`  --reviewer-script <path>     ${formatModeLabel("--reviewer-script", cliArgOptions)} Override adapter script path`);
  console.log(`  --reviewer-model <name>      ${formatModeLabel("--reviewer-model", cliArgOptions)} Reviewer model override`);
  console.log(`  --allow-behind-base          ${formatModeLabel("--allow-behind-base", cliArgOptions)} Proceed despite a behind-base warning`);
  console.log(`  --wait-for-checks <seconds>  ${formatModeLabel("--wait-for-checks", cliArgOptions)} Wait up to N seconds for PR checks to leave the pending bucket before reviewing`);
  console.log(`  --detach                     ${formatModeLabel("--detach", cliArgOptions)} Run the round in a detached supervisor (crash-only) and print a receipt`);
  console.log(`  --prepare-only               ${formatModeLabel("--prepare-only", cliArgOptions)} Emit prompt bundle only; do not apply verdict`);
  console.log(`  --no-comment                 ${formatModeLabel("--no-comment", cliArgOptions)} Do not post a PR comment`);
  console.log(`  --json                       ${formatModeLabel("--json", cliArgOptions)} Output JSON`);
}

function printResult({
  doneCriteriaPath,
  diffPath,
  jsonOut,
  manifestPath,
  originalState,
  prepareOnly,
  prNumber,
  promptPath,
  redispatchPath,
  result,
  updatedManifest,
  verdictPath,
}) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (prepareOnly) {
    console.log(`Prepared relay review round ${result.round}`);
    console.log(`  Manifest:      ${manifestPath}`);
    console.log(`  Prompt:        ${promptPath}`);
    console.log(`  Done criteria: ${doneCriteriaPath}`);
    console.log(`  Diff:          ${diffPath}`);
    return;
  }

  console.log(`Applied relay review round ${result.round}`);
  console.log(`  Manifest: ${manifestPath}`);
  console.log(`  State:    ${originalState} -> ${updatedManifest.state}`);
  console.log(`  Prompt:   ${promptPath}`);
  console.log(`  Verdict:  ${verdictPath}`);
  if (redispatchPath) console.log(`  Re-dispatch: ${redispatchPath}`);
  if (result.commentPosted) console.log(`  PR comment posted to #${prNumber}`);
}

module.exports = {
  printUsage,
  printResult,
};
