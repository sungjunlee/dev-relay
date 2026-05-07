---
milestone: Relay Intake / Preflight
status: active
started: 2026-05-07
due: TBD
epic: 431
---

# relay-ready (Epic #431)

## Goal
`relay-intake` is renamed to `relay-ready`, gates dispatch with a real 3-dimension readiness check, and `/relay` autoroutes through it via a deterministic non-interactive probe — proven by ≥1 wired downstream consumer (`verifiability → tdd_anchor`) and observable in reliability metrics.

## Plan

Phase ordering is dependency-driven, not capacity-driven. **Phase 1 must finish before Phase 2.** Phase 2 implementation issues are parallel-eligible after Phase 1 lands. Phase 3 is observation-only and waits on ≥20 real runs of the new system.

### Phase 1 — Spec (lock the design before any code)

**Coupling note:** #432 + #433 are spec-only siblings that together lock the contract for everything else. Land as **two paired PRs in close succession** (one PR each, both reviewed before any Phase 2 dispatch starts) — they're separate concerns (rubric vs call-graph) so a single PR would muddy review focus, but Phase 2 cannot start until both have merged. Sequence: #432 first (rubric/extractor/schema decisions are inputs to the call-graph spec), #433 immediately after.

- [x] #432 Spec: rubric to 3 dimensions + default-extractor choice + schema migration plan — PR #440 / `1d2cdc8` merged 2026-05-07 (1 dispatch + R1 PASS clean; codex+codex)
- [x] #433 Spec: /relay call graph — non-interactive readiness probe + chain prompt — PR #443 / `43dff93` merged 2026-05-07 (1 dispatch + R1 PASS clean; codex+codex; 374 added words / target ≤500)

### Phase 2 — Implementation (parallelizable after Phase 1 spec-lock)

Dependency graph inside Phase 2:
- `#434` (rename) is mechanical and independent — can ship first or last
- `#435` (`score-readiness.js`) is a hard prerequisite for #436 and #437 — ship before either
- `#436` (Q&A loop) consumes #435 + Phase 1 extractor decision
- `#437` (`/relay` probe + chain offer) consumes #435 + Phase 1 call-graph decision; can land in parallel with #436

Suggested order: `#434 → #435 → (#436 ∥ #437)`.

- [ ] #434 Mechanical rename: relay-intake → relay-ready + deprecation shim (~1 dispatch)
- [ ] #435 Implement: score-readiness.js — deterministic 3-dim scorer + bypass conditions (~1–2 dispatches)
- [ ] #436 Implement: adaptive sequential Q&A loop (≤3 budget, escalation, default-extraction) (~1–2 dispatches)
- [ ] #437 Implement: /relay readiness probe + chain offer (~1 dispatch)

### Phase 3 — Wire-up + observation (only after Phase 2 ships AND ≥20 runs accumulate)

- [ ] #438 Wire single consumer: verifiability → relay-plan tdd_anchor (cut other 4 wires) (~1 dispatch)
- [ ] #439 Calibration metrics + escalation recovery + multi-leaf budget edges (deferred; needs ≥20 runs)

## Running Context

Decisions carried in from the handoff doc (`~/.craftkit/handoff/docs/dev-relay-5ae960.md`). Read it for full rationale; the one-liners below are anchors.

- **Rubric is 3-D, not 5-D** — `clarity` / `granularity` / `verifiability` only. `risk` and `dependency` are world-properties and overlap with existing dispatch-time checks (`extractRubricSize` regex, in-flight-run check from #408). Three independent lens reviews converged on this cut. Trigger to revisit: 3rd consumer demand emerging from real run data.
- **`/relay` stays long-running autonomous with exactly one human prompt** — the chain offer when probe fails. Architectural directive from user; closes craft-critique Failure Mode #4 (direct-dispatch bypass).
- **Wire ONE downstream consumer first** — `verifiability → tdd_anchor`. Cut the other 4 wires per `feedback_consumer_first_gate` rule of three.
- **Adaptive sequential one-question-at-a-time, NOT batched parallel** — each answer changes the next question. Hard cap ≤3 questions then escalate.
- **Rename with deprecation shim, not hard cut** — users have stale `~/.claude/skills/relay-intake/` from old `npx skills add` runs (memory: `project_stale_installed_skills`). Shim removed in next +1 release.
- **Reuse existing milestone "Relay Intake / Preflight"** — this is v2 of the same skill; v1 issues #126–#133 (closed) live there too.
- **v1.1 1-pager source:** `/tmp/relay-ready-1pager.md` (ephemeral); content snapshotted into #432 issue body this session for durability. Final home: `skills/relay-ready/references/design-v1.md` after #434 rename lands (per #432 deliverables).

## Out-of-scope notes (do NOT bundle)

- Folding `relay-ready` into `relay-plan` — breaks `/relay` long-running silent dispatch property
- Wiring all 5 dimensions to consumers — deferred per consumer-first gate
- New state machine — reuse existing manifest
- `request_id` plumbing on bypass-path runs (parked observation from eng-review; watch during #437, may need a small companion issue)
- Issue #131 (legacy v1 follow-up — external refinement adapters) intentionally excluded from this sprint; reassess after v2 calibrates

## Progress

- 2026-05-07: Sprint file created. Epic #431 + sub-issues #432–#439 already filed in milestone "Relay Intake / Preflight". Baseline `relay-intake` tests green (21/21). v1.1 1-pager snapshotted as comment on #432 ([comment 4393141721](https://github.com/sungjunlee/dev-relay/issues/432#issuecomment-4393141721)) before /tmp loss risk. **Dogfooding note:** /relay does NOT yet auto-route through relay-ready — that capability is precisely what this epic ships (#437). So this dispatch exercises the existing /relay flow on #432; the loop closes once #437 lands and subsequent dispatches probe through `score-readiness.js` first.
- 2026-05-07: #432 dispatched via /relay-plan + /relay-dispatch. Run id `issue-432-20260507002236107-87053fc4`. Executor=codex, reviewer=codex per `feedback_prefer_codex_heavy_workflow`. Rubric size fallback to xhigh (cosmetic — `size: small` was rejected by extractRubricSize regex per `feedback_dispatch_size_regex_bug`; harmless for a 4-bullet spec task, just over-allocates reasoning).
- 2026-05-07: #432 dispatch finished in 231s, single commit, PR #440 opened (337 words, all 4 AC hit). Tried codex reviewer — failed with OpenAI strict-mode schema error (`factor`/`attempted_approach`/`fix_direction` in `properties` but not `required`). Filed **#441** to capture, verified `model_per_phase.review` = null × 98 in reliability report (codex reviewer was silently broken since pre-#430). Tried claude reviewer — `claude --bare` lacks API key auth (separate from interactive OAuth).
- 2026-05-07: Direct-landed narrow infra fix as **PR #442 / `ff1424e`** (4 files, 42+/19−; mirrors #304 `relates_to` precedent — nullable+required on the 3 rejection-metadata fields). Tightened the structural strict-mode invariant test so future regressions break at test-time, not at first reviewer run. Tests 318/318 + 800/800 sibling. Per `feedback_unblock_via_infra_pr`.
- 2026-05-07: Codex reviewer re-run on PR #440 → **R1 PASS clean** (verdict: `pass`, contract+quality both `pass`, 0 issues, 5/5 scope-drift `verified`, factors 10/10 + 10/10 + automated×2). State `ready_to_merge`. Stopping at the orchestrator-merge boundary per relay skill convention. **Dogfood loop closed half-way:** /relay system reviewed its own design-v1.md spec; the chain-offer probe doesn't exist yet (that's #437) so this dispatch was the existing flow. The fully recursive loop closes when #437 ships.
- 2026-05-07: **#432 merged** as PR #440 / `1d2cdc8` (squash). `finalize-run.js` ran cleanup-only path (mergeRecovered=true): worktree removed, issue-432 branch deleted local+remote, issue closed, manifest state=merged. Phase 1 unblocks #433.
- 2026-05-07: **#433 dispatched + merged same session.** Run id `issue-433-20260507123727776-7b761997`. Dispatch 185s → PR #443 (+50 lines, 2 files: design-v1.md call-graph append + relay/SKILL.md probe section). Codex reviewer R1 PASS clean (verdict pass, contract+quality both pass, 0 issues, all 4 AC VERIFIED, 374 added words). Merged as `43dff93` (squash). **#441 schema fix validated** — first successful codex review since pre-#430 (reliability report had `model_per_phase.review` = null × 98). **Phase 1 complete** — Phase 2 implementation (#434/#435/#436/#437) now unblocked.
