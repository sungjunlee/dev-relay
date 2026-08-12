# Direct Orchestration vs Relay Retrospective

**Date:** 2026-08-02

**Scope:** Runtime Core Reset vNext implementation and review without Relay

**Measurement anchor:** the arc's endpoint figures below are measured at
`353f6fc`, the squash of PR #1143, and the `from` baseline at `46f2fac`. They are
deliberately not restated when later work changes the same quantities — doing so
would fold that work's lines and tests into a delta this arc did not produce. For
current values see `docs/script-inventory-and-cleanup.md`.

## Outcome

Direct orchestration completed the code reset while retaining all seven native
executors. The installed dispatch runtime fell from 75 JavaScript files / 29,607
LOC to 18 files / 8,165 LOC. Excluding the two migration-only shims, the core is
16 files / 6,049 LOC. The serialized gate on Node v22.22.3 reports 703 tests, 701
passed, 0 failed, and 2 skipped; both skips were then-approved opt-in provider
canaries. They were later retired and do not describe the current gate.

Both figures are the anchor's, per the measurement rule above, and are left
as measured. Later work moved them: the migration overlay was deleted on
2026-08-03, so the shims no longer exist and the installed runtime is now the
core. See `docs/script-inventory-and-cleanup.md` for current values.

The runtime is larger than the figure published at the reset because production
CLI isolation (#1141) added credential staging, the signed two-phase cleanup
lifecycle, and runtime-identity binding after that measurement was taken.

At `353f6fc`, the rollout was not complete: the live adapter matrix was honestly
2/13, and shim retirement still required 30 days plus 30 vNext terminal runs
with zero legacy reads. Both Codex cells pass the real production path; the
remaining eleven carry typed external blockers, not weakened isolation. That
retirement gate was never run: the overlay was deleted outright on 2026-08-03.

## What Direct Orchestration Did Better

- Model choice followed the work. Clear implementation went to implementation
  agents; high-risk lifecycle reasoning and review used Sol; external models
  were attempted only where an independent model family could add value.
- Review findings were converted directly into focused implementation loops.
  The strongest example was cleanup recovery: review found PID-reuse, pathname
  TOCTOU, signed-close ordering, and reviewer-reap gaps; the follow-up closed all
  four and received an explicit LGTM.
- The orchestrator could reject false completion evidence. The historical
  provider matrix correctly reported incomplete external evidence rather than
  manufacturing a green status; it was later retired because provider login is
  not a repository release condition.
- Simplification stayed coupled to the live import graph. The unused generic
  adapter and its identity framework were deleted while the seven native
  descriptors and their extension contract remained.

## Where Direct Orchestration Paid More

- Coordination state lived in the orchestrator's context rather than a durable
  per-leaf manifest. File ownership, review status, and the reason for each retry
  required active bookkeeping.
- Two external-model calls consumed long wall-clock windows without a usable
  result: Opus 5 implementation was stopped at 30 minutes and GLM-5.2 review at
  15 minutes. Bounded deadlines prevented an unbounded loop, but the attempts
  still added latency without review evidence.
- The first full gate exposed a real zombie-state bug; the second exposed a
  generated-ledger omission. Both loops were useful, but a durable workflow
  could have made the “code green vs generated evidence stale” distinction more
  visible earlier.
- Review convergence was manually enforced. The orchestrator had to remember
  which reviewer owned each finding and explicitly request the LGTM re-review.

## What Relay Would Likely Have Improved

- Durable ownership and review lineage would reduce context pressure and make
  incomplete leaves easier to resume.
- A standardized review state would make “fix requested → patch → same reviewer
  LGTM” auditable without reconstructing the sequence from conversation state.
- Explicit evidence slots could separate code gates, operator-local provider
  availability, calendar gates, and external-model availability instead of
  treating them as one broad completion condition.

## What Relay Should Not Reintroduce

- Mandatory advisory lanes, assurance profiles, model routing catalogs, review
  budgets, and fallback policy were not needed to reach the result.
- Skips or fallback-model successes must never substitute for the declared
  adapter/model cell.
- A fixed loop count should not force another review after the owning reviewer
  has issued LGTM and the relevant serialized gate is green.
- Executor diversity belongs in small native descriptors, not in a central
  policy framework or generic argv-template execution surface.

## Recommended Relay Changes

1. Keep a small durable leaf contract: owner, immutable Done Criteria, exact
   review anchor, current finding set, and evidence status.
2. Make review loops finding-driven. Re-run the owning reviewer only while an
   actionable finding remains or relevant code changed.
3. Give external delegates hard default deadlines and record timeout as
   unavailable evidence, not as a reason to restart the whole workflow.
4. Keep operator-local provider availability out of the repository test gate;
   `code_green`, calendar retirement, and external review should not collapse
   into one state.
5. Preserve the direct approach's subtraction bias: new policy machinery needs
   a demonstrated invariant or incident, a production caller, and a retirement
   rule.

## Bottom Line

The improved base models can complete a change of this size without Relay, and
they found issues that mattered. Relay's remaining value is durable coordination
and evidence lineage, not additional policy loops. A smaller Relay should retain
those two strengths while dropping mandatory review machinery that does not
change the finding set or the release decision.
