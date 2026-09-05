"use strict";

/** Durable --all cockpit scan and retained-worktree GC helpers for relay-status. */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const factsModule = require("../../relay-dispatch/scripts/facts");
const { foldRunFacts } = require("../../relay-dispatch/scripts/inspect");
const runStore = require("../../relay-dispatch/scripts/run-store");

function relayHomeDirectory() {
  return path.resolve(process.env.RELAY_HOME || path.join(os.homedir(), ".relay"));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function ageDays(createdAt, nowMs) {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return null;
  return Math.max(0, Math.floor((nowMs - createdMs) / 86_400_000));
}

function isLocalRoute(record) {
  return String(record.repo?.remote || "").startsWith("local/");
}

function nextCommand(record, classification) {
  const scripts = __dirname;
  const mechanical = new Set(["verified", "attempt_dangling", "merged_unclosed"]);
  if (isLocalRoute(record) && mechanical.has(classification)) {
    return `node ${shellQuote(path.join(scripts, "relay-advance.js"))} --repo ${shellQuote(record.repo.root)} --run-id ${shellQuote(record.run_id)} --json`;
  }
  return `node ${shellQuote(path.join(scripts, "relay-recover.js"))} inspect --repo ${shellQuote(record.repo.root)} --run-id ${shellQuote(record.run_id)} --json`;
}

function durableClassification(record, facts, derived) {
  const types = new Set(facts.map((fact) => fact.type));
  if (types.has("run_closed")) return "terminal";
  if (types.has("merge_recorded")) return "merged_unclosed";
  if (derived.terminal === true) return "terminal";
  const starts = facts.filter((fact) => fact.type === "attempt_started");
  const latestStart = starts.at(-1);
  const startIndex = latestStart ? facts.indexOf(latestStart) : -1;
  const currentFacts = facts.slice(startIndex + 1);
  const currentTypes = new Set(currentFacts.map((fact) => fact.type));
  if (currentTypes.has("review_recorded")) return "reviewed";
  if (currentTypes.has("verification_recorded")) return "verified";
  if (!latestStart) return "empty";
  const finished = currentFacts.some((fact) => (
    fact.attempt_id === latestStart.attempt_id
    && (fact.type === "attempt_finished" || fact.type === "attempt_interrupted")
  ));
  return finished ? "attempt_dangling" : "attempt_open";
}

function readDurableRun(runDir, repoSlug, nowMs, suppliedRecord = null) {
  const record = suppliedRecord || runStore.readRunRecord({ runDir });
  if (record.version !== 3) throw new Error(`unsupported run version: ${record.version}`);
  const journal = factsModule.readFacts({ eventsPath: path.join(runDir, "events.jsonl") });
  const derived = foldRunFacts({
    runRecord: record,
    facts: journal.facts,
    gitFacts: {},
    githubFacts: {},
    hostFacts: {},
  });
  const classification = durableClassification(record, journal.facts, derived);
  const diagnostics = [];
  if (journal.tailIncomplete) diagnostics.push({ code: "incomplete_fact_tail" });
  for (const diagnostic of derived.diagnostics || []) diagnostics.push(diagnostic);
  return {
    repo_slug: repoSlug,
    run_id: record.run_id,
    run_dir: runDir,
    run_path: path.join(runDir, "run.json"),
    created_at: record.created_at,
    age_days: ageDays(record.created_at, nowMs),
    classification,
    next_command: classification === "terminal" ? null : nextCommand(record, classification),
    worktree: record.git.worktree,
    worktree_exists: fs.existsSync(record.git.worktree),
    diagnostics,
    record,
    facts: journal.facts,
    derived,
  };
}

function scanAllRuns({ relayHome = relayHomeDirectory(), nowMs = Date.now() } = {}) {
  const runsRoot = path.join(relayHome, "runs");
  const rows = [], terminalRows = [], legacyBySlug = new Map(), diagnostics = [];
  if (!fs.existsSync(runsRoot)) return { relayHome, runsRoot, rows, terminalRows, legacyBySlug, diagnostics };
  let slugEntries;
  try {
    slugEntries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({ code: "runs_scan_failed", path: runsRoot, message: error.message });
    return { relayHome, runsRoot, rows, terminalRows, legacyBySlug, diagnostics };
  }
  for (const slugEntry of slugEntries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const slugDir = path.join(runsRoot, slugEntry.name);
    let runEntries;
    try {
      runEntries = fs.readdirSync(slugDir, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({ code: "repo_slug_scan_failed", path: slugDir, message: error.message });
      continue;
    }
    for (const runEntry of runEntries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const runDir = path.join(slugDir, runEntry.name);
      let record;
      try {
        record = runStore.readRunRecord({ runDir });
      } catch (error) {
        const legacy = legacyBySlug.get(slugEntry.name) || [];
        legacy.push({ path: runDir, diagnostic: { code: error.code || "legacy_or_unreadable", message: error.message } });
        legacyBySlug.set(slugEntry.name, legacy);
        continue;
      }
      if (record.version !== 3) {
        const legacy = legacyBySlug.get(slugEntry.name) || [];
        legacy.push({
          path: runDir,
          diagnostic: { code: "UNSUPPORTED_RUN_VERSION", message: `run.version must be 3 (found ${record.version})` },
        });
        legacyBySlug.set(slugEntry.name, legacy);
        continue;
      }
      try {
        const row = readDurableRun(runDir, slugEntry.name, nowMs, record);
        if (row.classification === "terminal") terminalRows.push(row);
        else rows.push(row);
      } catch (error) {
        rows.push({
          repo_slug: slugEntry.name,
          run_id: record.run_id,
          run_dir: runDir,
          run_path: path.join(runDir, "run.json"),
          created_at: record.created_at,
          age_days: ageDays(record.created_at, nowMs),
          classification: "unprovable",
          next_command: nextCommand(record, "unprovable"),
          worktree: record.git.worktree,
          worktree_exists: fs.existsSync(record.git.worktree),
          diagnostics: [{ code: error.code || "durable_fold_failed", message: error.message }],
          record,
          facts: [],
          derived: {},
        });
      }
    }
  }
  return { relayHome, runsRoot, rows, terminalRows, legacyBySlug, diagnostics };
}

function publicRunRow(row) {
  const { record, facts, derived, ...publicRow } = row;
  return publicRow;
}

function pathClaimsCandidate(claimedPath, candidatePath) {
  const claimed = path.resolve(claimedPath), candidate = path.resolve(candidatePath);
  return claimed === candidate || claimed.startsWith(`${candidate}${path.sep}`);
}

function hasLegacyRunDirectories(scan) {
  return [...scan.legacyBySlug.values()].some((entries) => entries.length > 0);
}

function legacyLedgerIsProvablyEmpty(scan) {
  return scan.diagnostics.length === 0 && !hasLegacyRunDirectories(scan);
}

function worktreeCandidates(scan, { minAgeDays, nowMs = Date.now() }) {
  const worktreesRoot = path.join(scan.relayHome, "worktrees");
  const candidates = [];
  if (!fs.existsSync(worktreesRoot)) return candidates;
  const allV3 = [...scan.rows, ...scan.terminalRows];
  const byRunDir = new Map(allV3.map((row) => [path.resolve(row.run_dir), row]));
  const claimed = allV3.map((row) => ({ row, worktree: path.resolve(row.record.git.worktree) }));
  let topEntries;
  try {
    topEntries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
  } catch (error) {
    return [{ classification: "unprovable", worktree_path: worktreesRoot, eligible: false,
      diagnostics: [{ code: "worktrees_scan_failed", message: error.message }] }];
  }
  const addCandidate = (candidatePath, repoSlug, runId, runDir, layout) => {
    const owner = claimed.find((entry) => pathClaimsCandidate(entry.worktree, candidatePath));
    const runExists = runDir ? fs.existsSync(runDir) : false;
    const row = runDir ? byRunDir.get(path.resolve(runDir)) : null;
    let classification = "unprovable", reason = "ledger_state_unprovable", eligible = false;
    if (layout === "legacy_hash") {
      if (owner) {
        reason = "claimed_by_ledger";
      } else if (!legacyLedgerIsProvablyEmpty(scan)) {
        // Legacy manifests are unreadable by contract, so per-entry ownership is undecidable; only an empty legacy ledger makes absence provable.
        reason = "legacy_layout_unprovable";
      } else {
        classification = "orphan"; reason = "legacy_ledger_empty"; eligible = true;
      }
    } else if (!runExists && !owner) {
      classification = "orphan"; reason = "run_directory_missing"; eligible = true;
    } else if (!runExists && owner) {
      reason = "claimed_by_ledger";
    } else if (row && row.derived.terminal === true && row.age_days !== null && row.age_days >= minAgeDays) {
      classification = "terminal_aged"; reason = "terminal_age_threshold_met"; eligible = true;
    } else if (row?.derived.terminal === true) {
      reason = "terminal_too_young";
    } else if (row) {
      reason = "non_terminal";
    } else {
      reason = "legacy_bound";
    }
    candidates.push({
      repo_slug: repoSlug,
      run_id: runId,
      run_dir: runDir,
      worktree_path: candidatePath,
      layout,
      classification,
      reason,
      eligible,
      age_days: row?.age_days ?? null,
      applied: false,
      diagnostics: [],
    });
  };
  for (const topEntry of topEntries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const topPath = path.join(worktreesRoot, topEntry.name);
    if (/^[0-9a-f]+$/i.test(topEntry.name)) {
      addCandidate(topPath, null, null, null, "legacy_hash");
      continue;
    }
    let runEntries;
    try {
      runEntries = fs.readdirSync(topPath, { withFileTypes: true });
    } catch (error) {
      candidates.push({ repo_slug: topEntry.name, run_id: null, run_dir: null, worktree_path: topPath,
        layout: "current", classification: "unprovable", reason: "worktree_scan_failed", eligible: false,
        age_days: null, applied: false, diagnostics: [{ code: "worktree_scan_failed", message: error.message }] });
      continue;
    }
    for (const runEntry of runEntries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const bucket = path.join(topPath, runEntry.name);
      const runDir = path.join(scan.runsRoot, topEntry.name, runEntry.name);
      addCandidate(bucket, topEntry.name, runEntry.name, runDir, "current");
    }
  }
  return candidates;
}

function applyGcCandidate(candidate, scan, { minAgeDays, nowMs = Date.now() }) {
  if (!candidate.eligible) return candidate;
  try {
    const stat = fs.lstatSync(candidate.worktree_path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error("candidate is not a regular directory"), { code: "candidate_identity_changed" });
    if (candidate.classification === "orphan") {
      if (candidate.layout !== "current" && candidate.layout !== "legacy_hash") {
        throw Object.assign(new Error("orphan removal requires an exact current-layout run directory"), { code: "orphan_layout_unprovable" });
      }
      if (candidate.layout === "current" && !candidate.run_dir) {
        throw Object.assign(new Error("orphan removal requires an exact current-layout run directory"), { code: "orphan_layout_unprovable" });
      }
      const refreshedScan = scanAllRuns({ relayHome: scan.relayHome, nowMs });
      const claimedNow = [...refreshedScan.rows, ...refreshedScan.terminalRows]
        .find((row) => pathClaimsCandidate(row.record.git.worktree, candidate.worktree_path));
      if (claimedNow) throw Object.assign(new Error(`worktree is claimed by ${claimedNow.run_id}`), { code: "claimed_by_ledger" });
      if (candidate.layout === "legacy_hash") {
        if (refreshedScan.diagnostics.length > 0) {
          throw Object.assign(new Error("legacy ledger could not be revalidated before removal"), { code: "legacy_ledger_revalidation_failed" });
        }
        if (hasLegacyRunDirectories(refreshedScan)) {
          throw Object.assign(new Error("legacy run directory appeared before removal"), { code: "legacy_run_appeared" });
        }
      }
      if (candidate.run_dir && fs.existsSync(candidate.run_dir)) throw Object.assign(new Error("run directory appeared before removal"), { code: "run_directory_appeared" });
      fs.rmSync(candidate.worktree_path, { recursive: true });
      candidate.applied = true;
      return candidate;
    }
    const refreshed = readDurableRun(candidate.run_dir, candidate.repo_slug, nowMs);
    if (refreshed.derived.terminal !== true || refreshed.age_days === null || refreshed.age_days < minAgeDays) {
      throw Object.assign(new Error("run is no longer terminal and aged"), { code: "terminal_age_revalidation_failed" });
    }
    if (!pathClaimsCandidate(refreshed.record.git.worktree, candidate.worktree_path)) {
      throw Object.assign(new Error(`run.json git.worktree does not match ${candidate.worktree_path}`), { code: "worktree_binding_mismatch" });
    }
    fs.rmSync(candidate.worktree_path, { recursive: true });
    candidate.applied = true;
    try {
      execFileSync(process.env.RELAY_GIT_BIN || "git", ["-C", refreshed.record.repo.root, "worktree", "prune"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      candidate.diagnostics.push({ code: "git_worktree_prune_failed", message: error.stderr?.toString().trim() || error.message });
    }
  } catch (error) {
    candidate.diagnostics.push({ code: error.code || "gc_apply_failed", message: error.message });
  }
  return candidate;
}

function legacySummaries(legacyBySlug) {
  return [...legacyBySlug.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([repoSlug, entries]) => ({
    repo_slug: repoSlug,
    count: entries.length,
    paths: entries.map((entry) => entry.path),
    diagnostics: entries.map((entry) => ({ path: entry.path, ...entry.diagnostic })),
  }));
}

function formatAllText(payload) {
  const lines = payload.runs.map((row) => (
    `Run: ${row.repo_slug} ${row.run_id} age=${row.age_days === null ? "unknown" : `${row.age_days}d`} class=${row.classification} next=${row.next_command}`
  ));
  lines.push(`Terminal: ${payload.summary.terminal}`);
  for (const legacy of payload.legacy) lines.push(`Legacy: ${legacy.repo_slug} count=${legacy.count}`);
  if (payload.gc) {
    lines.push(`GC: ${payload.gc.apply ? "apply" : "dry-run"} min_age_days=${payload.gc.min_age_days}`);
    for (const candidate of payload.gc.candidates) {
      const diagnostic = candidate.diagnostics.length ? ` diagnostic=${candidate.diagnostics.map((entry) => entry.code).join(",")}` : "";
      let action = "manual";
      if (candidate.applied) action = "removed";
      else if (candidate.eligible) action = "reclaim";
      lines.push(`Worktree: ${candidate.classification} ${candidate.worktree_path} action=${action}${diagnostic}`);
    }
  }
  for (const diagnostic of payload.diagnostics) lines.push(`Diagnostic: ${diagnostic.code} ${diagnostic.path || ""} ${diagnostic.message || ""}`.trim());
  return lines.join("\n");
}

module.exports = {
  applyGcCandidate,
  durableClassification,
  formatAllText,
  legacySummaries,
  publicRunRow,
  readDurableRun,
  scanAllRuns,
  worktreeCandidates,
};
