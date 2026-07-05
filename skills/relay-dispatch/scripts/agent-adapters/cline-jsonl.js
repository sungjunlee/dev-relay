const fs = require("fs");
const {
  formatAdapterPhase,
} = require("./transport");

function parseClineJsonLine(line, { adapter, phase, lineNumber }) {
  try {
    return JSON.parse(line);
  } catch (error) {
    const context = formatAdapterPhase({ adapter, phase });
    throw new Error(`${context} Cline JSONL line ${lineNumber} must be valid JSON: ${error.message}`);
  }
}

function extractClineRunResultText(stdout, { adapter = "cline", phase = "unknown" } = {}) {
  const context = formatAdapterPhase({ adapter, phase });
  const raw = String(stdout || "");
  if (!raw.trim()) {
    throw new Error(`${context} Cline JSONL output is empty; no run_result.text payload found`);
  }

  let resultText = null;
  let runResultCount = 0;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const event = parseClineJsonLine(line, { adapter, phase, lineNumber: index + 1 });
    if (event?.type === "run_result") {
      runResultCount += 1;
      if (typeof event.text === "string") {
        resultText = event.text;
      }
    }
  }

  if (resultText === null) {
    const detail = runResultCount
      ? "run_result events did not include a string text field"
      : "no run_result events found";
    throw new Error(`${context} Cline JSONL output did not include run_result.text (${detail})`);
  }
  if (!resultText.trim()) {
    throw new Error(`${context} Cline run_result.text payload is empty`);
  }

  return resultText.trim();
}

function copyClineRunResultTextToResultFile({ stdoutLog, resultFile, adapter = "cline", phase = "dispatch" }) {
  const context = formatAdapterPhase({ adapter, phase });
  if (!stdoutLog) throw new Error(`${context} stdoutLog is required`);
  if (!resultFile) throw new Error(`${context} resultFile is required`);
  if (!fs.existsSync(stdoutLog)) {
    return { copied: false, status: "missing", bytes: 0 };
  }

  const resultText = extractClineRunResultText(fs.readFileSync(stdoutLog, "utf-8"), { adapter, phase });
  fs.writeFileSync(resultFile, `${resultText}\n`, "utf-8");
  return {
    copied: true,
    status: "extracted",
    bytes: Buffer.byteLength(`${resultText}\n`),
  };
}

module.exports = {
  copyClineRunResultTextToResultFile,
  extractClineRunResultText,
};
