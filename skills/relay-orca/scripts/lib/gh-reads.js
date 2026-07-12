"use strict";

// Pure GitHub read adapters for `status` (#945 D4). ONLY read-only `gh` subcommands
// are ever built here: `gh issue view <n> --json state,stateReason` and
// `gh pr view <n> --json state,mergedAt,headRefOid`. No write subcommand is
// reachable. Every builder receives an injected `run(ghBin, args, options)` so the
// subprocess boundary stays in the top-level script and plan.js's frozen lib
// source-scan keeps passing.
const { parseJson } = require("./bounded-excerpt");

// Read-only field list for `gh issue view` (D4). `gh issue view` is not covered by the
// repo-wide pr-view field-list contract, so a named constant is fine here.
const ISSUE_FIELDS = "state,stateReason";

function ghIssueView(run, ghBin, number, options = {}) {
  const args = ["issue", "view", String(number), "--json", ISSUE_FIELDS];
  const proc = run(ghBin, args, options);
  const parsed = parseJson(proc.stdout);
  if (proc.status !== 0 || !parsed.ok || !parsed.value) {
    return { ok: false, reachable: false, proc };
  }
  const value = parsed.value;
  return {
    ok: true,
    reachable: true,
    state: typeof value.state === "string" ? value.state : null,
    stateReason: typeof value.stateReason === "string" ? value.stateReason : null,
    proc,
  };
}

// The full D4 PR evidence (state, mergedAt, headRefOid) is fetched via two read-only
// `gh pr view` calls whose --json field lists are LITERAL strings already registered
// in the repo-wide pr-view field-list contract (tests/skills-lint). The first covers
// merge evidence (mergedAt,state); the second recovers the live head (headRefOid) for
// the PR_CHANGED head-moved detector. Both are read-only; the results are merged so
// callers see one `{ state, mergedAt, headRefOid }` fact.
//
// A20/A25: BOTH sub-reads are REQUIRED. If EITHER fails or returns invalid JSON, the PR
// source is unreachable (ok:false) — it must NEVER substitute `{}` for the head read
// and keep ok:true, because a resulting null `headRefOid` silently disables the
// PR_CHANGED head-moved detector and can complete a merged outcome whose head actually
// moved. An unreachable PR source degrades the outcome to stale_missing (A11/A20).
//
// A25: a head read that SUCCEEDS (status 0, valid JSON) but whose `headRefOid` is
// missing, empty, or non-string is ALSO unreachable — the live head could not be
// established, so the head comparison is skipped exactly as when the read failed. A
// real `gh pr view` on an existing PR always returns a non-empty head OID; anything
// else means the head fact is absent, and `pr_merged` must NEVER count as completion
// evidence when the head comparison was skipped. So the whole PR source degrades to
// stale_missing rather than false-completing a merged outcome off a null head.
function ghPrView(run, ghBin, number, options = {}) {
  const mergeArgs = ["pr", "view", String(number), "--json", "mergedAt,state"];
  const mergeProc = run(ghBin, mergeArgs, options);
  const mergeParsed = parseJson(mergeProc.stdout);
  if (mergeProc.status !== 0 || !mergeParsed.ok || !mergeParsed.value) {
    return { ok: false, reachable: false, proc: mergeProc };
  }
  const merge = mergeParsed.value;
  const headArgs = ["pr", "view", String(number), "--json", "number,headRefName,headRefOid"];
  const headProc = run(ghBin, headArgs, options);
  const headParsed = parseJson(headProc.stdout);
  if (headProc.status !== 0 || !headParsed.ok || !headParsed.value) {
    return { ok: false, reachable: false, proc: headProc };
  }
  const head = headParsed.value;
  if (typeof head.headRefOid !== "string" || head.headRefOid.trim() === "") {
    return { ok: false, reachable: false, proc: headProc };
  }
  return {
    ok: true,
    reachable: true,
    state: typeof merge.state === "string" ? merge.state : null,
    mergedAt: merge.mergedAt ?? null,
    headRefOid: head.headRefOid,
    proc: mergeProc,
  };
}

module.exports = { ISSUE_FIELDS, ghIssueView, ghPrView };
