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

function stderrTail(stderr) {
  const text = String(stderr || "");
  const trimmed = text.trim();
  return trimmed ? `; stderr tail: ${trimmed.slice(-500)}` : "";
}

function previewText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function extractClineAdvisoryCandidates(stdout, {
  adapter = "cline",
  phase = "advisory_review",
  stderr = "",
} = {}) {
  const context = formatAdapterPhase({ adapter, phase });
  const raw = String(stdout || "");
  if (!raw.trim()) {
    throw new Error(`${context} Cline JSONL output is empty; no advisory candidates found${stderrTail(stderr)}`);
  }

  let runResult = null;
  let runResultCount = 0;
  let lastTextContentEnd = null;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const event = parseClineJsonLine(line, { adapter, phase, lineNumber: index + 1 });
    if (event?.type === "run_result") {
      runResultCount += 1;
      runResult = event;
    }
    if (
      event?.type === "agent_event" &&
      event.event?.type === "content_end" &&
      event.event?.contentType === "text" &&
      typeof event.event.text === "string"
    ) {
      lastTextContentEnd = event.event.text;
    }
  }

  if (!runResultCount) {
    throw new Error(`${context} Cline JSONL output did not include a run_result event (no run_result events found)${stderrTail(stderr)}`);
  }

  if (runResult?.finishReason !== "completed") {
    const finishReason = runResult?.finishReason === undefined ? "undefined" : String(runResult.finishReason);
    const preview = previewText(runResult?.text, 300);
    throw new Error(
      `${context} Cline run_result finishReason "${finishReason}" was not "completed"; run_result.text preview: ${preview}`
    );
  }

  const candidates = [];
  for (const candidate of [runResult?.text, lastTextContentEnd]) {
    if (typeof candidate === "string" && candidate.trim()) {
      candidates.push(candidate.trim());
    }
  }
  if (!candidates.length) {
    throw new Error(`${context} Cline completed run_result did not include any non-empty advisory candidates`);
  }
  return candidates;
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
  extractClineAdvisoryCandidates,
  extractClineRunResultText,
};
