const { modeLabel } = require("../../../relay-dispatch/scripts/cli-args");

function printUsage() {
  console.log("Usage: review-runner.js --repo <path> (--run-id <id> | --branch <name> | --pr <number>) [options]");
  console.log("\nPrepare or apply a structured relay review round.");
  console.log("\nOptions:");
  console.log(`  --repo <path>                ${modeLabel("--repo")} Repository root (default: .)`);
  console.log(`  --run-id <id>                ${modeLabel("--run-id")} Relay run identifier`);
  console.log(`  --branch <name>              ${modeLabel("--branch")} Working branch`);
  console.log(`  --pr <number>                ${modeLabel("--pr")} PR number`);
  console.log(`  --manifest <path>            ${modeLabel("--manifest")} Explicit manifest path`);
  console.log(`  --done-criteria-file <path>  ${modeLabel("--done-criteria-file")} Use fixture file instead of gh issue fetch`);
  console.log(`  --diff-file <path>           ${modeLabel("--diff-file")} Use fixture file instead of gh pr diff`);
  console.log(`  --review-file <path>         ${modeLabel("--review-file")} Structured reviewer JSON verdict to apply`);
  console.log(`  --reviewer <name>            ${modeLabel("--reviewer")} Reviewer adapter to invoke (codex|claude|...)`);
  console.log(`  --reviewer-script <path>     ${modeLabel("--reviewer-script")} Override adapter script path`);
  console.log(`  --reviewer-model <name>      ${modeLabel("--reviewer-model")} Reviewer model override`);
  console.log(`  --advisory-reviewer <name>   ${modeLabel("--advisory-reviewer")} Optional non-gating reviewer adapter`);
  console.log(`  --advisory-profile <name>    ${modeLabel("--advisory-profile")} Advisory focus profile (default: blindspot)`);
  console.log(`  --advisory-reviewer-model <name> ${modeLabel("--advisory-reviewer-model")} Advisory model override`);
  console.log(`  --advisory-timeout <seconds> ${modeLabel("--advisory-timeout")} Advisory timeout`);
  console.log(`  --prepare-only               ${modeLabel("--prepare-only")} Emit prompt bundle only; do not apply verdict`);
  console.log(`  --no-comment                 ${modeLabel("--no-comment")} Do not post a PR comment`);
  console.log(`  --json                       ${modeLabel("--json")} Output JSON`);
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
