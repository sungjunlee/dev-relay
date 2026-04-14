const { execFileSync } = require("child_process");
const path = require("path");

const NO_HISTORY_TEXT = "no historical data available";

function buildDefaultCommand(repoRoot) {
  return {
    command: process.execPath,
    args: [
      path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "reliability-report.js"),
      "--repo",
      repoRoot,
      "--json",
    ],
  };
}

function formatFailureCause(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) {
    const [firstLine] = stderr.split("\n");
    if (firstLine) {
      return firstLine.replace(/^Error:\s*/, "").trim();
    }
  }

  if (typeof error?.status === "number") {
    return `exit code ${error.status}`;
  }

  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  return "unknown failure";
}

function extractStuckFactors(report) {
  const factors = report?.factor_analysis?.factors;
  if (!factors || typeof factors !== "object") {
    return NO_HISTORY_TEXT;
  }

  const entries = Object.entries(factors)
    .filter(([, summary]) => summary && typeof summary === "object")
    .filter(([, summary]) => (
      summary.met_rate !== 1
      || (typeof summary.avg_rounds_to_met === "number" && summary.avg_rounds_to_met >= 3)
    ))
    .map(([name, summary]) => {
      const parts = [];
      if (typeof summary.met_rate === "number") {
        parts.push(`met_rate=${summary.met_rate}`);
      }
      if (typeof summary.avg_rounds_to_met === "number") {
        parts.push(`avg_rounds_to_met=${summary.avg_rounds_to_met}`);
      }
      return `${name} (${parts.join(", ")})`;
    });

  const mostStuckFactor = report?.factor_analysis?.most_stuck_factor;
  if (typeof mostStuckFactor === "string" && mostStuckFactor.trim()) {
    const alreadyIncluded = entries.some((entry) => entry.startsWith(`${mostStuckFactor} (`));
    if (!alreadyIncluded && Object.hasOwn(factors, mostStuckFactor)) {
      const summary = factors[mostStuckFactor];
      const parts = [];
      if (typeof summary?.met_rate === "number") {
        parts.push(`met_rate=${summary.met_rate}`);
      }
      if (typeof summary?.avg_rounds_to_met === "number") {
        parts.push(`avg_rounds_to_met=${summary.avg_rounds_to_met}`);
      }
      entries.unshift(`${mostStuckFactor} (${parts.join(", ")})`);
    }
  }

  return entries.length > 0 ? entries.join("; ") : NO_HISTORY_TEXT;
}

function extractDivergenceHotspots(report) {
  const hotspots = report?.rubric_insights?.divergence_hotspots;
  if (!Array.isArray(hotspots) || hotspots.length === 0) {
    return NO_HISTORY_TEXT;
  }

  return hotspots
    .slice(0, 3)
    .map((hotspot) => (
      `${hotspot.factor_pattern} (avg_delta=${hotspot.avg_delta}, recommendation=${hotspot.recommendation})`
    ))
    .join("; ");
}

function extractAverageRounds(report) {
  const contractRounds = report?.rubric_insights?.tier_effectiveness?.contract?.avg_rounds_to_met;
  const qualityRounds = report?.rubric_insights?.tier_effectiveness?.quality?.avg_rounds_to_met;
  const medianRounds = report?.metrics?.median_rounds_to_ready;

  const values = [];
  if (typeof contractRounds === "number") {
    values.push(`contract.avg_rounds_to_met=${contractRounds}`);
  }
  if (typeof qualityRounds === "number") {
    values.push(`quality.avg_rounds_to_met=${qualityRounds}`);
  }
  if (typeof medianRounds === "number") {
    values.push(`metrics.median_rounds_to_ready=${medianRounds}`);
  }

  return values.length > 0 ? values.join("; ") : NO_HISTORY_TEXT;
}

function renderHistoricalSignalSection(result) {
  if (result.status === "unavailable") {
    return [
      `Historical signal: Reliability report unavailable: ${result.cause}. Proceeding without historical signal.`,
      `historical_signal.stuck_factors: ${NO_HISTORY_TEXT}`,
      `historical_signal.divergence_hotspots: ${NO_HISTORY_TEXT}`,
      `historical_signal.avg_rounds: ${NO_HISTORY_TEXT}`,
    ];
  }

  if (result.empty_history) {
    return [
      "Historical signal: Empty-data state — historical signal not available, proceed to rubric design.",
      `historical_signal.stuck_factors: ${NO_HISTORY_TEXT}`,
      `historical_signal.divergence_hotspots: ${NO_HISTORY_TEXT}`,
      `historical_signal.avg_rounds: ${NO_HISTORY_TEXT}`,
    ];
  }

  return [
    "Historical signal:",
    `historical_signal.stuck_factors: ${result.historical_signal.stuck_factors}`,
    `historical_signal.divergence_hotspots: ${result.historical_signal.divergence_hotspots}`,
    `historical_signal.avg_rounds: ${result.historical_signal.avg_rounds}`,
  ];
}

function readHistoricalSignal(repoRoot, command = buildDefaultCommand(repoRoot)) {
  try {
    const stdout = execFileSync(command.command, command.args, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const report = JSON.parse(stdout);
    const emptyHistory = report?.totals?.manifests === 0 && report?.totals?.events === 0;
    return {
      status: "available",
      empty_history: emptyHistory,
      report,
      historical_signal: {
        stuck_factors: extractStuckFactors(report),
        divergence_hotspots: extractDivergenceHotspots(report),
        avg_rounds: extractAverageRounds(report),
      },
    };
  } catch (error) {
    return {
      status: "unavailable",
      cause: formatFailureCause(error),
      historical_signal: {
        stuck_factors: NO_HISTORY_TEXT,
        divergence_hotspots: NO_HISTORY_TEXT,
        avg_rounds: NO_HISTORY_TEXT,
      },
    };
  }
}

module.exports = {
  NO_HISTORY_TEXT,
  buildDefaultCommand,
  readHistoricalSignal,
  renderHistoricalSignalSection,
};
