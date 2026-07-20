---
milestone: Recovery & Finalize Polish
status: completed
started: 2026-07-10
due: TBD
objectives: []
component: "merge-finalize"
---

# recovery-finalize-polish

## Goal
Close the small recovery/finalize gaps accumulated across the last two arcs: operator evidence can replace timeout placeholders, squash merges keep conventional PR titles in main history, and PR-check polling stops being session-improvised.

## Plan

### Batch 1 — disjoint surfaces, fully parallel (3 leaves)

- [x] #856 + #806 — SHIPPED BY OTHER SESSION before activation (PR #886, `--replace-placeholder-evidence`, 3R); removed from this sprint's dispatch set.
- [x] #864 — MERGED (PR #894) 2026-07-10, cursor/grok-4.5-high R1 PASS.
- [x] #840 — MERGED (PR #895) 2026-07-10, 2R (R1 caught a real no-checks-path bug; cursor executor fixed).

### Batch 1 additions (2026-07-10, planned post-hoc — surfaces verified disjoint)

- [x] #876 — MERGED (PR #896) 2026-07-10, 2R (R1 = PR-body root-cause narrative only; code accepted R1). Root cause: drive trusted dry-run rowName and bypassed the poll deadline; liveness now = lease pid double-probe, pgid never decides.
- [x] #889 — MERGED (PR #898) 2026-07-10, R1 PASS. DC precondition correctly BLOCKED run 1 (lifecycle lacked the edge) → DC amendment put the one edge in scope → fresh run (cursor) shipped lifecycle edge + whitelist row + docs collapse.

### Not in this sprint

- #868 relay-config migrate (Phase C territory) — belongs to the route-config-simplification sprint alongside held #783; do not pick up here.
- #838 review checkpoint — gated `status:awaiting-consumer` (2026-07-09).
- #815/#816 test flakes — observation items with known conventions (serialized fleet suite, fixture reaping).

## Running Context

- Single wave: all three surfaces verified disjoint; one fleet (`fleet-recovery-polish-w1`) or three parallel /relay singles — either works.
- Activate this sprint only after fleet-hygiene-reliability Batch 1 has landed (shared reviewer/quota bandwidth, and #850's advisory fix benefits these reviews too).
- Reviewer: primary codex; advisory `opencode-go/glm-5.2` if #850 has landed.
- Sprint writes are orchestrator-single-writer; fleet children never touch `backlog/`.

## Progress

### 2026-07-10 (SPRINT COMPLETE — wave 1 all merged, fleet closed)
- fleet-recovery-polish-w1 `closed`: #864/#876/#840/#889 all MERGED (PRs #894/#896/#895/#898). Superseded #889 run 1 closed with audit (precondition STOP worked as designed).
- **Codex quota exhaustion mid-wave → full pipeline pivot to cursor/grok-4.5-high** (executor AND reviewer) per operator direction: probe → canary (#864 R1 PASS) → all reviews + both fix rounds on cursor. Review quality held (real bug caught in #840 R1; #876 R1 demanded the root-cause narrative and itself traced the early-reconcile path from the diff).
- Behind-base review gate (#884, other session) fired its first live rounds — three branches rebased + evidence re-authored at rebased heads (gate 199/995/1070 pass).
- #889 arc validated the DC-precondition pattern end-to-end: verify-don't-modify blocked cleanly, planner amendment widened scope deliberately, fresh dispatch shipped the lifecycle edge.

### 2026-07-10 (activated + wave 1 launched)
- Activated after fleet-hygiene-reliability completed. Reality-check against the concurrent session's shipped work: #856/#806 already merged (PR #886) — struck from plan; their live arc (#882-885, #783) explicitly avoided.
- Wave 1 = fleet-recovery-polish-w1: #876 (live-reconcile fix) + #889 (one-hop unblock) + #864 (squash --subject) + #840 (wait-for-check.js), 4 disjoint leaves, executor/reviewer codex. #840's docs scope narrowed to cli-schema.md to avoid #889's recovery-playbook.md surface.
