const { buildExecutionEvidencePreflight } = require("./execution-evidence");

function maybeBlockForExecutionEvidencePreflight({
  data,
  jsonOut,
  result,
  reviewFile,
  reviewedHeadSha,
  round,
  runDir,
  strict,
}) {
  result.executionEvidencePreflight = buildExecutionEvidencePreflight({
    runDir,
    reviewedHead: reviewedHeadSha,
    strict,
  });
  if (reviewFile || result.executionEvidencePreflight.status === "pass") {
    return false;
  }

  result.nextState = data.state;
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Review preflight blocked round ${round}: ${result.executionEvidencePreflight.reason}`);
    console.log(`  Next action: ${result.executionEvidencePreflight.nextAction}`);
  }
  process.exitCode = 2;
  return true;
}

module.exports = {
  maybeBlockForExecutionEvidencePreflight,
};
