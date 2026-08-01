function emitJsonFailure(error, { jsonOut }) {
  if (jsonOut) {
    console.log(JSON.stringify({
      status: "failed",
      error: error.message,
      ...(error.adapter ? { adapter: error.adapter } : {}),
      ...(error.phase ? { phase: error.phase } : {}),
    }, null, 2));
  }
}

function printFailureAndExit(error, { jsonOut }) {
  emitJsonFailure(error, { jsonOut });
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

module.exports = {
  printFailureAndExit,
};
