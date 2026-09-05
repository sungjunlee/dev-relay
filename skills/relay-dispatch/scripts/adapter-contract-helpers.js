"use strict";

/** Outcome-parse helpers for the native adapter contract. */

const fs = require("fs");

function readOutput(outputPath) { return !outputPath || !fs.existsSync(outputPath) ? "" : fs.readFileSync(outputPath, "utf8"); }

function parseJsonlRunResult(text) {
  let result = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`jsonl_run_result line ${index + 1} must be valid JSON: ${error.message}`);
    }
    if (event?.type === "run_result") result = event;
  }
  if (!result || typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("jsonl_run_result requires a non-empty run_result.text");
  }
  return { text: result.text, value: result.text };
}

function parseOutput(protocol, { stdoutPath, resultPath }) {
  const resultText = readOutput(resultPath);
  const stdoutText = readOutput(stdoutPath);
  const text = resultText || stdoutText;
  if (protocol === "text_stdout") return { text, value: text };
  if (protocol === "json_result") {
    if (!text.trim()) throw new Error("json_result output is empty");
    try {
      return { text, value: JSON.parse(text) };
    } catch (error) {
      throw new Error(`json_result is invalid JSON: ${error.message}`);
    }
  }
  if (protocol === "jsonl_run_result") return parseJsonlRunResult(text);
  throw new Error(`unknown output protocol '${protocol}'`);
}

function outcomeStatus({ exitCode, signal, timedOut, cancelled, text }) {
  if (timedOut) return "timed_out";
  if (cancelled || signal) return "cancelled";
  if (exitCode !== 0) return "failed";
  return text && text.trim() ? "succeeded" : "empty";
}

function makeParseOutcome(outputProtocol) {
  return function parseOutcome({ phase = "dispatch", exitCode = 0, signal = null, timedOut = false, cancelled = false, completionProven = false, stdoutPath, stderrPath, resultPath }) {
    let parsed = { text: "", value: null };
    let parseError = null;
    if (completionProven || (exitCode === 0 && !signal && !timedOut && !cancelled)) {
      try {
        const protocol = typeof outputProtocol === "function" ? outputProtocol(phase) : outputProtocol;
        parsed = parseOutput(protocol, { stdoutPath, resultPath });
        if (phase !== "dispatch" && protocol === "jsonl_run_result") {
          try {
            parsed = { text: parsed.text, value: JSON.parse(parsed.text) };
          } catch (error) {
            throw new Error(`jsonl_run_result.${phase} text is invalid JSON: ${error.message}`);
          }
        }
      } catch (error) {
        parseError = error;
      }
    }
    let status;
    if (parseError) status = "failed";
    else if (completionProven) status = parsed.text && parsed.text.trim() ? "succeeded" : "empty";
    else status = outcomeStatus({ exitCode, signal, timedOut, cancelled, text: parsed.text });
    return Object.freeze({
      status,
      summary: parseError ? parseError.message : parsed.text.trim().slice(0, 500),
      resultPath: resultPath || stdoutPath || null,
      output: parsed.value,
      stderrPath: stderrPath || null,
    });
  };
}

module.exports = {
  makeParseOutcome,
  outcomeStatus,
  parseJsonlRunResult,
  parseOutput,
  readOutput,
};
