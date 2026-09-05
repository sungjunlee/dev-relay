const crypto = require("crypto");
const path = require("path");
const { readFacts } = require("./facts");
const { readRunRecord } = require("./run-store");
const {
  foldRunFacts,
  isLocalDelivery,
} = require("./inspect-helpers");
const VOLATILE_ACTION_KEYS = new Set(["at", "duration_ms", "error", "nonce", "observed_at", "request_nonce"]);
function stable(value, omitVolatile = false) {
  if (Array.isArray(value)) return value.map((entry) => stable(entry, omitVolatile));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).filter((key) => !omitVolatile || !VOLATILE_ACTION_KEYS.has(key))
    .sort().map((key) => [key, stable(value[key], omitVolatile)]));
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function actionKey(value) { return digest(JSON.stringify(stable(value, true))); }
function defaultSnapshot(runDir) {
  const runRecord = readRunRecord({ runDir });
  const journal = readFacts({ eventsPath: path.join(runDir, "events.jsonl") });
  return { runDir, runRecord, facts: journal.facts, snapshot: {
    run_sha256: digest(JSON.stringify(runRecord)),
    facts_sha256: digest(JSON.stringify(journal.facts)), fact_count: journal.facts.length,
    last_event_id: journal.facts.at(-1)?.event_id || null,
    tail_status: journal.tailIncomplete ? "incomplete" : "complete",
  } };
}
function observations(raw = {}) {
  return { git: raw.git || raw.gitFacts || {}, github: raw.github || raw.githubFacts || {},
    host: raw.host || raw.hostFacts || {}, verification: raw.verification || {}, blockers: raw.blockers || [] };
}
function blocker(code, message, retryable = false, details = {}) { return { code, message, retryable, details }; }
function matchingRecordedPr(facts, github) {
  const fact = facts.filter((item) => item.type === "pull_request_recorded").at(-1);
  return fact && fact.payload.pr_number === github.pr_number && fact.payload.repo === github.repo
    && fact.payload.head_ref === github.head_ref && fact.payload.base_ref === github.base_ref ? fact : null;
}
function recoverySteps(derived, seen, facts = []) {
  if (isLocalDelivery(seen.git)) {
    if (derived.reason === "attempt_liveness_unknown") {
      return seen.host.live === false ? ["close_dead_attempt"] : [];
    }
    if (seen.git.reviewable_dirty === true) return ["commit_work"];
    if (String(derived.reason || "").startsWith("verification_")) return ["record_verification"];
    if (derived.reason === "reviewed_result_ready") return ["close_reviewed_result"];
    return [];
  }
  if (derived.reason === "merged_pr_unrecorded" && matchingRecordedPr(facts, seen.github)) return ["record_external_merge"];
  if (derived.reason === "attempt_liveness_unknown") return seen.host.live === false ? ["close_dead_attempt"] : [];
  const steps = [], head = seen.git.head_sha || derived.head_sha;
  const prior = facts.filter((fact) => fact.type === "pull_request_recorded").at(-1);
  const reusable = seen.github.pr_state === "OPEN" && Number(seen.github.matching_pr_count) === 1;
  const publish = derived.reason === "publication_incomplete" || seen.git.reviewable_dirty === true
    || (reusable && seen.github.pr_head_sha !== head)
    || (reusable && (!prior || prior.payload.head_sha !== seen.github.pr_head_sha));
  if (publish) {
    if (seen.git.reviewable_dirty === true) steps.push("commit_work");
    if (seen.git.reviewable_dirty === true || seen.git.remote_head_sha !== head) steps.push("push_branch");
    steps.push("record_or_create_pr");
  }
  if (String(derived.reason || "").startsWith("verification_")) steps.push("record_verification");
  return [...new Set(steps)];
}
function deriveBlockers(snapshot, facts, seen, derived) {
  const out = snapshot.tail_status === "complete" ? [] : [blocker("event_tail_incomplete", "facts journal has an incomplete tail", true)];
  for (const item of seen.blockers) out.push(blocker(item.code || "observation_blocked", item.message || "external observation is incomplete", item.retryable === true, item.details || {}));
  if (seen.github.lookup_complete === false) out.push(blocker("github_pr_lookup_incomplete", "GitHub PR lookup is incomplete", true));
  if (Number(seen.github.matching_pr_count) > 1) out.push(blocker("ambiguous_pr", "multiple PRs match the immutable run identity"));
  if (["ahead_local", "diverged"].includes(seen.git.remote_relation)) out.push(blocker("remote_branch_conflict", "remote branch cannot be advanced safely"));
  if (seen.github.pr_state === "MERGED" && !matchingRecordedPr(facts, seen.github)) out.push(blocker("unrecorded_merged_pr", "a merged branch PR is not bound to the durable run PR identity"));
  if (derived.reason === "reviewed_worktree_dirty") {
    out.push(blocker(
      "reviewed_worktree_dirty",
      "the retained worktree contains uncommitted reviewable changes after review",
      true,
    ));
  }
  if (derived.reason === "github_pr_closed_unmerged") out.push(blocker("github_pr_closed_unmerged", "the durable run PR is closed without a merge"));
  if (derived.reason === "fact_conflict") out.push(blocker("fact_conflict", "durable facts or external identity conflict"));
  return out;
}
function recommendedAction(snapshot, facts, seen, derived, blockers) {
  let kind = derived.action, steps = kind === "recover" ? recoverySteps(derived, seen, facts) : [];
  if (blockers.length || (kind === "recover" && !steps.length)) { kind = "operator_attention"; steps = []; }
  const action = { kind, reason: blockers[0]?.code || derived.reason, steps,
    required_inputs: steps.includes("record_verification") ? ["verification_file"] : [] };
  return { ...action, key: actionKey({ run_sha256: snapshot.run_sha256,
    observations: { git: seen.git, github: seen.github, host: { live: seen.host.live }, verification: seen.verification }, derived, action }) };
}
async function inspectRun({ runDir, observer, readSnapshot = defaultSnapshot } = {}) {
  if (typeof observer !== "function") throw new Error("inspectRun requires an observer function");
  const before = await readSnapshot(runDir);
  const seen = observations(await observer({ operation: "inspect", phase: "observe", runDir: before.runDir, runRecord: before.runRecord, facts: before.facts }));
  const derived = foldRunFacts({ runRecord: before.runRecord, facts: before.facts,
    gitFacts: seen.git, githubFacts: seen.github, hostFacts: seen.host });
  const after = await readSnapshot(runDir);
  const blockers = deriveBlockers(before.snapshot, before.facts, seen, derived);
  if (before.snapshot.run_sha256 !== after.snapshot.run_sha256 || before.snapshot.facts_sha256 !== after.snapshot.facts_sha256) {
    blockers.unshift(blocker("snapshot_changed", "run facts changed during read-only inspection; retry from a fresh snapshot", true));
  }
  return { schema_version: 1, operation: "inspect", run_id: before.runRecord.run_id, snapshot: before.snapshot,
    facts: before.facts, observations: { git: seen.git, github: seen.github, host: seen.host, verification: seen.verification },
    derived, blockers, recommended_action: recommendedAction(before.snapshot, before.facts, seen, derived, blockers) };
}
module.exports = {
  actionKey,
  defaultSnapshot,
  foldRunFacts,
  inspectRun,
  matchingRecordedPr,
  recoverySteps,
  stable,
};
