# Relay Instruction Altitude — Retiring the Unreliability Tax

Status: proposal (2026-07-26)
Builds on: **#1025 (shipped, PR #1034, merged 2026-07-19)** — Risk-adaptive relay simplification. That epic already reduced the *prescription tax*; this PRD addresses the second tax #1025 named but did not tackle.
Related: `docs/plans/2026-07-19-risk-adaptive-relay-simplification-design.md`, ADR-0001 (orchestrator owns publication), auto-recover-commit (#508, #1060), recover-commit bug cluster (#806, #856, #793, #904, #876)

## Summary

As models improve, the right direction is fewer detailed instructions and more focus on the core. Relay carries two masses that a 2026-era model lets it shed:

- **Prescription tax** — rubric/review harnessing that told the model *how to think*. **This is already resolved.** Epic #1025 ("subtract procedural harnessing while preserving the boundaries that make delegation safe") shipped the min-anchor default, Outcome/Verification/Earned-Rubric separation, zero-scored-factor validity, reviewer-only scoring, and risk-proportional assurance — merged, dogfooded (#1036), and calibrated (#1035). This PRD does **not** re-open it.

- **Unreliability tax** — recovery machinery (`recover-commit.js`, `rebrand-evidence.js`, `reconcile-run.js` row-6 salvage) that exists only because the executor says "done" without committing/pushing/opening a PR. #1025's problem statement named this as a symptom ("harness-caused recovery work") but its workstreams did not touch it. Relay's current answer is to run recovery **automatically** (`auto-recover-commit` default-ON, #508/#1060) — which removes operator friction but keeps the machinery, and that machinery has spawned its own bug spiral (#806/#856/#793/#904/#876).

The proposal: finish the same subtraction #1025 started, on the reliability axis. Eliminate the executor-misbehavior failure mode **structurally** (extend orchestrator ownership from push+PR to the commit step), instrument what the recovery machinery actually catches, and retire the machinery on evidence — the same "delete legacy only after comparative evidence" discipline #1025 used.

## Problem

### The prescription-tax half is done; this is the reliability half

#1025 correctly framed the goal as "central enforcement of intent, permission, isolation, observable evidence, auditability, and explicit approval, with broad model autonomy inside those boundaries." Its six durable boundaries are exactly the *trust kernel* — the part that survives any model IQ. It subtracted procedural harnessing from **planning and review**. It left the **executor-handoff** harnessing in place, and in fact hardened it (auto-recover-commit default-ON) rather than removing it.

### The unreliability tax, itemized

Of the recovery surface, the pieces that exist for executor misbehavior (not infrastructure failure):

| Script / path | Exists because | Infra or misbehavior? |
| --- | --- | --- |
| `recover-commit.js` | "executor completed but did not commit/push/open a PR" | misbehavior |
| `reconcile-run.js` row-6 salvage | "committed but never pushed" | misbehavior |
| `rebrand-evidence.js` | "executor evidence was wrong; orchestrator corrected it, must re-stamp" | misbehavior |
| lease/crash rows, `cleanup-worktrees.js` | supervisor/host death, orphaned worktrees | **infra — keep** |

The misbehavior rows are the tax. Memory and dogfood data show it is not rare: opus-class executors skip the commit step roughly half the time, which is exactly why #508/#1060 made recovery automatic.

### Automatic recovery removed the friction but kept the liability

Making `auto-recover-commit` default-ON was a reasonable mitigation — the operator no longer runs a manual recovery step. But it is a mitigation of a symptom, not removal of a failure mode:

- The machinery still exists and still runs on ~half of dispatches.
- It has its own defect surface: `#806`, `#856`, `#793` (timeout placeholder evidence blocks recover-commit / cannot record missing execution evidence), `#904`, `#876` (row-4 recovery must stamp execution evidence / premature recover publishes a mid-work snapshot). Each is a bug *in the tax*, not in the feature work.
- Authorship/evidence drift: because the orchestrator commits on the executor's behalf after the fact, `rebrand-evidence.js` exists to re-bind evidence when a correction commit lands on top.

A structurally impossible failure mode generates no recovery code and no recovery bugs.

## Trust Kernel vs Compensatory Scaffolding

The organizing distinction (a restatement of #1025's "durable boundaries" vs "procedural harnessing", extended to the reliability axis):

| | Trust kernel | Compensatory scaffolding |
| --- | --- | --- |
| Definition | Survives any model IQ; a boundary pinned regardless of capability | Shrinks as models improve; compensates for the model not doing what it was told |
| Reliability-axis examples | Crash-only recovery (lease + reconcile for real process/host death); PR = handoff boundary; observable execution evidence; SHA-freshness merge gate | `recover-commit`, `rebrand-evidence`, salvage row — recovery for an executor that skipped commit/push/PR |
| Direction | Harden freely | Remove the failure mode, then retire the recovery |

#1025 applied this split to planning/review. This PRD applies the same split to the executor handoff.

## Goals

- Make executor-skipped-commit **structurally impossible**, so the corresponding recovery machinery becomes dead code rather than default-ON runtime.
- Instrument what the recovery machinery actually catches, per executor/model, so retirement is evidence-gated (the #1025 discipline).
- Retire only the misbehavior-recovery paths whose invocation trends to zero after the structural fix; keep all infrastructure recovery.
- (Secondary) Reduce the orchestrator spine's procedural density where #1025's subtraction did not reach — the `relay` SKILL.md lifecycle loop.

## Non-goals

- Do **not** re-open or duplicate #1025's shipped prescription-tax work (rubric, review, assurance tiers). It is done.
- Do **not** weaken crash-only recovery, lease-based liveness, `cleanup-worktrees`, the SHA-freshness merge gate, or any of #1025's six durable boundaries.
- Do **not** remove `auto-recover-commit` or any recovery script before the structural fix has driven its invocation rate toward zero under real dispatch.
- Do **not** change adapter capability gates, route policy, or manifest role bindings.
- Do **not** over-specify this PRD's own issues; state the observable WHAT and the metric, leave the HOW to the executor.

## Design Principles

1. **Remove the failure mode, then retire the recovery.** `#198` already made push+PR orchestrator-owned. Extending orchestrator ownership to the commit step makes "executor forgot to commit" impossible by construction, which is strictly better than recovering from it automatically.

2. **Instrument before deleting.** Emit an invocation count for each misbehavior-recovery path per executor/model. Deletion is gated on that count trending to zero after the structural fix — the same comparative-evidence gate #1033 used.

3. **Keep infrastructure recovery untouched.** Machine/process death is always possible; the lease/reconcile/cleanup paths are trust kernel and stay.

4. **The orchestrator is an agent, not a flowchart runner.** Where the `relay` spine still spells out poll/branch/snapshot/compare/recover as prose the model executes, move it into a driver command and let the spine state the goal.

## Resolved Design Decisions

**Orchestrator-owned commit is clean — it eliminates the rebrand path rather than complicating it (resolved 2026-07-26, code-verified).**

- `execution-evidence.json` is *already* orchestrator-written (`dispatch.js` → `writeExecutionEvidence`, stamped `recorded_by: "dispatch-orchestrator-v1"`), bound at write-time to whatever HEAD exists after the executor finishes. On the recovery path a commit lands *after* that binding, which is the sole reason `rebrand-evidence` exists (it rewrites `head_sha` to the new commit and files the old one under a `rebrand` block).
- Reordering the happy path so the orchestrator commits the worktree diff as the *last* step, then binds evidence once to that final SHA, removes the ordering artifact — no rebrand for the normal path. `buildExecutionEvidence` only requires a SHA that exists at write time; the executor's result file is already on disk, so a single binding suffices.
- git authorship is **not** tied to the executor anywhere: no `--author` is set, and nothing reads `%an`/`%ae`. Attribution lives in manifest `roles.executor` and evidence `recorded_by`, both orchestrator-controlled. Orchestrator-owned commit therefore loses no provenance. (`git commit --author=<executor>` is available as an *optional* new provenance signal, not a requirement.)

Consequence: Issue B is not a risky new mechanism; it promotes the orchestrator's existing commit capability (which `recover-commit` already exercises) from a recovery path to the normal path, and Issue C can retire `recover-commit` **and** `rebrand-evidence` (not just `recover-commit`) once the data confirms it.

## Issue Breakdown

Delivered in order; each independently dispatchable. Acceptance criteria are observable and metric-anchored.

### Issue A: Instrument the unreliability tax (baseline)

Establish the measurement before changing behavior.

Acceptance criteria:
- `reliability-report` surfaces per-executor/model invocation rate of `recover-commit`, `rebrand-evidence`, and `reconcile-run` row-6 salvage over recent runs, distinguishing them from infrastructure recovery (lease/crash/cleanup).
- Output is JSON and human-readable, consistent with existing `--by-role` / `--by-lane` modes.
- The report names what it could not classify (no silent truncation).
- No behavior change to dispatch or recovery in this issue.

### Issue B: Orchestrator-owned commit (structural fix)

Make executor-skipped-commit impossible.

Acceptance criteria:
- On executor completion, the orchestrator commits the retained worktree diff under the run's identity; an executor that edits but never commits yields a committed run **without** invoking `recover-commit`.
- A dispatch where the executor commits normally is behavior-identical (no double commit, no evidence rebrand).
- Execution evidence is bound once to the final orchestrator-commit SHA with no rebrand on the normal path (see Resolved Design Decisions).
- Infrastructure recovery (lease/crash, reconcile dead/interrupted rows, cleanup) is unchanged.
- No recovery script is deleted in this issue.

### Issue C: Retire misbehavior-recovery on evidence (gated)

Delete the dead tax once the data confirms it.

Acceptance criteria:
- Blocked until Issue A's report shows the misbehavior-recovery invocation rate trending to zero across a real observation window post-Issue-B (mirror the #1036 dogfood gate).
- Retire only the misbehavior paths whose invocation reached zero; keep every infrastructure path and keep `auto-recover-commit` reachable as an explicit fallback for unmanaged executors that cannot use orchestrator-owned commit, if any remain.
- Removal follows the one-release deprecation-window rule; document what was removed and why in the script-inventory doc.

### Issue D (secondary): Thin the orchestrator spine to a goal

Reduce lifecycle-loop procedural density in the `relay` spine.

Acceptance criteria:
- A single driver command owns the dispatch→review lifecycle loop (poll until state leaves `dispatched`, run review, handle stale/recover) that the `relay` SKILL.md currently spells out step by step.
- `relay` SKILL.md expresses the goal, stop condition (`ready_to_merge`), and trust invariants in place of the JSON-field branching table, and stays well under 150 lines.
- The state machine, transition guards, and recovery paths are unchanged — only their invocation surface moves from prose to a command.
- Existing `/relay` scenario tests pass without weakening any assertion.

## Open Questions

- ~~**Authorship / evidence semantics.**~~ **Resolved (2026-07-26)** — see Resolved Design Decisions. Orchestrator-owned commit eliminates the rebrand path and loses no provenance; Issue B is a reorder, not a new mechanism.
- **Unmanaged executors.** Some adapters may not expose a worktree the orchestrator can commit cleanly. Does orchestrator-owned commit cover all current executors, or does `auto-recover-commit` stay as a scoped fallback for a named subset?
- **Is Issue D worth it?** `operator-surface.md` calls SKILL.md the "decision spine" deliberately. Is the `relay` lifecycle loop genuinely over-proceduralized, or is its explicitness load-bearing for operators driving manual phases? Measure spine length and operator-reported friction before committing.
- **Scope vs #755/#838.** Open issues #755 (no re-review path for orchestrator corrections after `ready_to_merge`) and #838 (recoverable review interruption) touch adjacent recovery surface; confirm no overlap before dispatch.

## Recommended Delivery Order

1. Issue A — instrument (baseline before any change).
2. Issue B — orchestrator-owned commit (the structural fix).
3. Issue C — retire misbehavior-recovery, gated on A's post-B evidence.
4. Issue D — thin the spine (optional; gate on the "is it worth it" question).

This mirrors #1025's own sequence — measure, subtract behavior, delete machinery only on comparative evidence — applied to the one tax that arc left standing.
