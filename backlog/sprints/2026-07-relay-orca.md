---
milestone: Relay-Orca — Supervised Program Orchestration Pilot
status: completed
started: 2026-07-15
due: TBD
objectives: []
component: "manifest-lifecycle"
---

# relay-orca-closure

## Goal

Close the remaining real-runtime correlation, integration lifecycle, and re-admission gaps so a bounded relay-orca program can complete and admit the next program without manual receipt/dispatch intervention or a global reset.

## Activation Gate

- Keep this sprint `planned` while `2026-07-route-config-simplification.md` remains the single active sprint.
- Activate only through the normal sprint transition after the active sprint closes or the user explicitly reorders sprint ownership.
- Before the final closure re-pilot, enumerate runtime ownership and ask the user whether to run `orca orchestration reset --tasks`; never reset unprompted.

## Plan

### Batch 1 — make the verification gate trustworthy (serial, two small relay cycles)

- [x] #1020 field-aware receipt hygiene — DONE (CLOSED) — S; remove provider-path false positives first so every later Codex/Claude worktree can trust the full gate.
- [x] #1018 document relay-orca in the broad final gate — DONE (CLOSED) — XS; blocked by #1020, then verify the exact documented command from a provider-named worktree.

### Batch 2 — close relay correlation (one core relay cycle)

- [x] #1016 persist and recover the program marker — DONE (CLOSED; first-class --coordination-marker + attach-marker recovery) — M/L; first-class dispatch-time marker plus audited idempotent recovery. No direct manifest/receipt edit and no executor replay.

### Batch 3 — close integration lifecycle (one high-risk relay cycle)

- [x] #1019 canonical integration gate + terminal lifecycle + current completion provenance — DONE 2026-07-21 (PR #1041) — L; blocked on #1016 for the final end-to-end correlation contract.

### Batch 4 — make successful programs reusable (one high-risk relay cycle)

- [x] #1021 reset-free re-admission after verified closure — DONE 2026-07-21 via accepted relay-ready split req-20260720234611279: leaf 1 closed-program-proof (PR #1058, 8R) + leaf 2 historical-admission-filter (PR #1059, 7R). Historical resolved state is ignored only when attribution and terminality are proven; every ambiguous/foreign case remains fail-closed.

### Batch 5 — closure re-pilot and epic decision

- [x] #941 run a fresh bounded closure re-pilot — RUN 2026-07-22 (programs closure-941-20260722 + r2) against the real Orca runtime: marker persistence → discovery → mapping, one canonical integration gate, all program tasks terminal, `PROGRAM_COMPLETE: true`, stop idempotent, and an immediate `probe-orca admitted:true` without reset or raw/manual bridges.
- [x] Present the closure evidence and leave the final promote/iterate/remove decision to the user — VERDICT: ITERATE (user, 2026-07-23); epic #941 closed with evidence report.

## Execution Policy

- Every implementation issue uses a normal relay cycle: fetch → relay-plan/DC preflight → detached executor → CI/load-gated independent review → squash merge with `Fixes #N`.
- Core implementation route: Codex Luna xhigh executor; Cursor Grok 4.5 primary reviewer; OpenCode GLM-5.2 blindspot advisory. Claude Opus owns review-requested implementation fixes in the retained run worktree; Sonnet is suitable for read-only integration evidence.
- Reviewers are never Claude and never the executor engine. Reviewer spawn requires PR CI green plus two sub-8 load readings 60 seconds apart.
- Coordinator and Orca terminals never edit implementation code. Tests use fixtures and never invoke real `orca` or `gh`; only the closure re-pilot uses the real runtime.
- Run targeted suites inside relay worktrees and the complete serialized gate on merged main. Main CI is authoritative under host contention; discriminate any singleton failure first.
- Sprint/backlog files are orchestrator-single-writer. Do not touch `2026-07-route-config-simplification.md` while executing this sprint plan.

## Running Context

- Re-pilot `repilot-941-20260715` proved the architecture can ship two real relay outcomes and reach evidence-backed completion, but marker discovery failed and produced #1016.
- The same final state exposed a stronger closure contradiction: `PROGRAM_COMPLETE: true` while `probe-orca` rejected `active_tasks=1, gates=2`. Issues #1019 and #1021 split lifecycle closure from subsequent admission policy.
- The first serialized gate from a `.codex` worktree false-failed receipt hygiene; a token-free exact-SHA rerun passed 2518 tests with 0 failures. #1020 must land before #1018 makes relay-orca part of every documented broad gate.
- Defer follow-up-wave materialization, `--map-relay-fleet`, and `probe --smoke` changes until a real consumer exercises those paths.

## Progress

### 2026-07-15 — planned from unbridged re-pilot evidence

- Registered #1019 (integration lifecycle closure), #1020 (field-aware receipt hygiene), and #1021 (reset-free re-admission); all are milestone #12, `priority:high`, and `orca`-scoped.
- Added #1018 to milestone #12 with documentation/orca labels. Existing #1016 remains the first core correlation blocker.
- Ordered the closure sprint as test trust → marker correlation → integration lifecycle → reset-free admission → one final real-runtime re-pilot.
- Sprint intentionally remains `planned` because route-config simplification is the single active sprint.

### 2026-07-23 — sprint closed: Batch 5 run, verdict ITERATE

- Both closure re-pilot programs supervised three real merged outcomes (#1060→PR #1061, #1057→PR #1062, #1053→PR #1065) with marker→discovery→mapping proven 3/3 and evidence-gated completion discipline throughout.
- Shipped-path `PROGRAM_COMPLETE` + no-reset readmission remained unreachable: two same-day Orca app restarts reissued the runtime session id while the task DB persisted (#1063, reproduced 2×), and the #1019 gate lifecycle proved unrunnable against real Orca v1.4.x coordinator-provenance shapes (#1067). Also filed: #1066 (superseded-run advancement block), #1064 (operator-guidance alignment).
- Epic #941 CLOSED with verdict ITERATE: fix #1063/#1067/#1066/#1064, then one short confirmation re-pilot before the promote decision re-opens. Epic #872 (fleet hygiene) closed as functionally complete the same day.
- Full evidence: epic #941 closing comments + `~/.relay/closure-941-20260722/pilot-journal.md`.
