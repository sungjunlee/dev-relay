---
milestone: Route Config Simplification
status: active
started: 2026-07-05
due: TBD
objectives: []
component: "dispatch-execution"
---

# route-config-simplification

## Goal
Route selection is one user-facing concept: a single routes.json schema (open-by-default, strict opt-in) drives dispatch/review routing, presets make per-run intent one word, and relay-config can audit and revise its own config — so agent delegation stops requiring memorized flags or forgotten setup.

## Plan

### Batch 1 — substrate + independent bugfix (parallelizable)

- [ ] #784 relay-config inspect: opencode/pi model-list probes time out (ETIMEDOUT at 5s) — S, ~1 relay run; independent of the phase chain, good parallel candidate alongside #781
- [ ] #781 Routes single concept: unified routes.json, open-by-default posture, strict opt-in (Phase A) — L; expect 2–3 dispatches or a fleet split (loader/gate → relay-config vocabulary → friction wiring + ADR 0007)

### Batch 2 — per-run UX (blocked by #781)

- [ ] #782 Route presets: --route-preset, /relay natural-language mapping, model catalog (Phase B) — M

### Batch 3 — self-audit (blocked by #781)

- [ ] #783 relay-config revise mode: gaps --json, conversational amendments, migrate (Phase C) — M; degrades gracefully without #782 (preset_broken gap type inert until presets exist)

## Running Context

- Design reference: `docs/route-config-simplification-design.md`. Dependency chain: #781 → #782 → #783; #784 independent.
- Posture flip is a shipped-behavior change: no-config default goes fail-closed → open. Legacy `policy.json` holders keep current semantics until migrated (#781 loading order). ADR 0007 required in the #781 PR.
- `evaluateRelayRoute()` must stay unchanged — routes config maps to the policy-shaped object in memory. No derived policy.json file (drift is the disease being treated).
- `UNREGISTERED_ROUTE_USED` goes into the frozen EVENTS enum with write-time validation coverage (#313 pattern); consumers are #783 gaps and reliability-report.
- SKILL.md prose is pinned by sibling test suites (PR #746 incident): every phase that rewords SKILL.md runs the FULL repo suite.
- relay-config is a wrapper (skills/relay-config) delegating to a core script (skills/relay-dispatch/scripts/relay-config.js): vocabulary rename lands in both; `allow-route` alias kept one release.
- Phase D (relay-plan route recommendation + fleet per-leaf fill) is NOT in this sprint — observe-gated on ≥~10 non-default-route runs over ~4 weeks after A–C ship.

## Progress

### 2026-07-05
- Sprint planned. Design doc committed (72fab9f), issues #781–#784 created with milestone "Route Config Simplification", task mirrors synced (81f79c6).
