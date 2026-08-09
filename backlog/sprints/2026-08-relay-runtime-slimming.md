---
milestone: relay-runtime-slimming
status: active
started: 2026-08-09
due: TBD
component: "dispatch-execution"
---

# Relay Runtime Slimming

## Goal

Remove vNext transition residue and unearned compatibility, recovery, and test-accounting machinery so the single Relay runtime is accurately documented, smaller, and fully verified.

## Plan

### Batch 1 — Canonical vocabulary and contract

- [x] #1193 — retire vNext transition vocabulary and dead compatibility selectors [PR:#1198]

### Batch 2 — Independent correctness patch

- [x] #1191 — validate worktree-base containment before creation side effects [PR:#1199]

### Batch 3 — Measured compatibility retirement

- [x] #1194 — measure and retire unused legacy rubric, ownership, and lineage compatibility [PR:#1200]

### Batch 4 — Recovery mechanism subtraction

- [~] #1195 — shrink or remove special pre-run stranded-worktree recovery [branch:codex/1195-remove-pre-run-recovery]

### Batch 5 — Test-accounting and seam simplification

- [ ] #1196 — simplify Relay test accounting and narrow internal testing seams

### Batch 6 — Program closure

- [ ] #1197 — verify the final runtime baseline, reconcile docs/issues, and close the epic

## Running Context

- GitHub epic #1197 is canonical; child Issues own acceptance criteria and lifecycle.
- The current runtime is the Relay runtime. `vNext` is retained only where dated historical evidence requires it.
- Deletion is judged by the module deletion test: if complexity vanishes, delete it; if it spreads to callers, retain the smallest deep interface that contains it.
- Historical artifacts do not authorize permanent runtime compatibility. Every retained compatibility branch needs a measured current consumer and retirement condition.
- Do not introduce a migration overlay, intent sidecar, mutable lifecycle, second recovery writer, cleanup daemon, or dispatch-side recovery.
- Preserve all seven executor adapters; executor diversity is not a simplification target.
- Do not spend rename churn on ledger/test artifacts until #1196 decides which ones survive.
- Baseline at epic creation: 16 relay-dispatch JS files / 6,906 LOC; 48 Relay test files / 14,848 LOC; `recover.js` 2,187 LOC.

## Progress

- 2026-08-09 — Closed the stale core-reset sprint after reconciling GitHub #1129–#1136. Created epic #1197 and children #1193–#1196, retained #1191 as the independent correctness item, closed completed #1190 with PR #1192 evidence, and admitted this ordered cleanup sprint.
- 2026-08-09 — #1193 implementation complete on `codex/relay-runtime-slimming`: removed two zero-consumer compatibility selectors, replaced current vNext terminology with Relay terminology, and corrected the capability/docs contract. Runtime 6,906→6,900 LOC; tests 14,848→14,838 LOC. Full gate passed 623/625 with 2 expected live-canary skips; independent review reached LGTM after two P2 current-doc corrections.
- 2026-08-09 — Merged #1198, completing #1193 and establishing the current Relay vocabulary before the remaining runtime-slimming batches.
- 2026-08-09 — #1191 implementation complete on `codex/1191-worktree-base-containment`: canonicalized stable path prefixes while creating only the Relay-owned suffix component-by-component, so platform aliases remain valid and pre-existing Relay-home/worktree-base symlinks fail before writes. Runtime 6,900→6,938 LOC; tests 14,838→14,884 LOC. Full gate passed 626/628 with 2 expected live-canary skips; independent review reached LGTM after fixing two P2 compatibility/contract findings.
- 2026-08-09 — Merged #1199, completing #1191. Started #1194 from measured callers and 12 anonymous local run records: removed zero-caller ownership aliases/injection and duplicate active-sprint helpers, kept the documented rubric-as-Done-Criteria path (1/10 schema-v3 consumers), and classified 2 versionless records as invalid historical input rather than adding a reader.
- 2026-08-09 — #1194 implementation complete on `codex/1194-retire-legacy-compat`: target runtime 1,343→1,248 LOC (−95), Relay tests 14,884→14,672 LOC (−212), registration sites 566→555. Scoped relay-merge/relay 126/126 and cross-skill 93/93 passed; independent review reached LGTM after three evidence/contract corrections. Two local serialized full-gate attempts exposed three unrelated long-run timing failures; each failed test passed in isolation, so the PR skill matrix is the final full-gate authority.
- 2026-08-09 — Merged #1200, completing #1194. #1195 REMOVE implementation complete on `codex/1195-remove-pre-run-recovery`: deleted the unauthenticated pre-run branch recovery route and 699 lines from `recover.js`; caught failures still unwind, while a post-add kill and same-branch retry preserve the branch/worktree pair with typed `BRANCH_EXISTS` guidance. Generated totals are runtime 6,941→6,238 LOC (−703), tests 14,675→14,009 LOC (−666), and registration sites 555→539. Scoped relay-dispatch/relay passed 353/355 with 2 expected live-canary skips; the full serialized gate passed 601/603 with the same 2 expected skips; independent review reached LGTM with no P1/P2 findings.
