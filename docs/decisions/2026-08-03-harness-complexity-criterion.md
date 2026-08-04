# 2026-08-03 — When this harness stops being worth it

Status: accepted (2026-08-03)

The standing direction is extreme simplification, on the premise that at some
complexity this harness stops being used because a stronger model doing the work
directly is simply better. That premise deserves a written criterion, so it does
not have to be re-litigated for every issue.

## The dividing line

A block of this harness earns its place if it supplies a property **a stronger
model cannot supply from inside a single process.** Anything whose job is to
compensate for model weakness has a shrinking half-life; anything whose job is
to survive the world outside the model does not.

Properties that do not get cheaper as models improve:

- **Durability across process death.** A run must survive a crash, a reboot, a
  killed terminal. That is a systems property. A better model does not make
  `events.jsonl` unnecessary.
- **Independence of review.** A reviewer bound to an exact SHA, frozen Done
  Criteria, and a different process is a structural guarantee. A stronger model
  reviewing its own output is still the same model with the same blind spots.
- **Containment.** Worktree isolation and argv-only execution bound the damage
  of a confident wrong action. Confidence is not the failure mode that improves.
- **Concurrency.** Two agents on one repository still race. Locks are not
  intelligence.

Properties that do get cheaper, and should be measured rather than assumed:

- Prompt scaffolding, rubric synthesis, readiness scoring, planning aids.
- Multi-round review loops, which exist because round one is often wrong.
- Recovery machinery, which exists because executors leave work uncommitted,
  die mid-run, or report success falsely.

## Three questions for any block

1. **Does it survive process death?** If its value exists only inside one live
   session, a stronger model with more context replaces it.
2. **Does it bind two independent parties?** If a single model could produce the
   same guarantee by being asked nicely, it is instruction, not a gate — and
   instruction belongs in a prompt, not in 300 lines of validation.
3. **Was it built by an incident or by an anticipation?** Anticipation-built
   machinery is where unearned complexity accumulates, because nothing ever
   demonstrates it was needed. Apply this question carefully: it is the easiest
   of the three to answer wrongly. On 2026-08-03 it was applied to the migration
   overlay's retirement gate, which looked like pure anticipation — and that
   deletion had to be withdrawn, because one function inside it was the only
   detector for a legacy writer still installed on the machine. "Nothing ever
   demonstrates it was needed" and "nothing has needed it *yet*" read identically
   from inside the code. Before answering, find the thing the block would catch
   and check whether that thing can still happen.

   The overlay was deleted later the same day anyway — but on a different
   finding, and that difference is the point. Question 3 never carried it. What
   carried it was measuring the mechanism's own entry condition: every path to a
   dispatchable marker required an attestation file owned by a different UID all
   the way up to `/`, which on a one-person machine is satisfiable only by
   becoming root and signing to yourself. The block was not unproven, it was
   unusable. Prefer that kind of finding: run the mechanism and watch it refuse,
   rather than reading it and inferring that nothing needs it.

## Numeric tripwires

Two ratios measurable today, plus one that matters more and currently has no
instrument. Each threshold says *investigate*, not *delete on sight*.

| Tripwire | Reading (2026-08-03) | Threshold |
| --- | ---: | --- |
| **A. Accounting : runtime** — `tests/skills-lint/scripts` + `tests/ledger` over `skills/relay-dispatch/scripts` | 4,649 : 6,050 = **0.77** | > 0.5 — tripped |
| **B. Transition share** — dispatch-runtime LOC that exists only to get from an old version to a new one | 0 : 6,050 = **0%** | > 15% — clear |
| **C. Recovery rate** — share of runs where recovery machinery did real work | **no instrument** | < 10% |

State A's denominator whenever quoting it: against all of `skills/**/*.js`
(14,414) the same numerator reads 0.32 and does not trip. The 0.77 reading is
accounting against the *dispatch runtime specifically*, which is what the ledger
accounts for, so it is the right comparison — but the ratio moves with the
denominator and must not be quoted bare.

A went **up** when 2,212 lines of runtime were deleted, because the accounting
shrank by only 64. That is not an artifact to explain away: it is the tripwire
working. Ledgers that account for a smaller runtime should get smaller too, and
this one barely did.

**C has no instrument, and that is itself the finding.** The nearest number in
reach is "~39% of 301 dev-relay runs carry the misbehavior tax" from #1081
(2026-07-26). It cannot be used here for three separate reasons: the tool that
produced it, `reliability-report.js`, was deleted by the vNext reset (#1140); the
figure explicitly *excluded* 110 `state_recovery` runs, so it measures executor
misbehavior rather than the crash/lease machinery this tripwire is about; and
Issue B of #1081 shipped a fix aimed at driving it down, making it a pre-fix
baseline. Nor can it be re-derived from `~/.relay/runs` yet: there were **zero
vNext `run.json` files machine-wide** when this was written, because the overlay
had blocked every dispatch. That blocker is gone, so the numbers can now
accumulate on their own.

C matters most in the long run, because `recover.js` (1,488) and `host.js`
(1,297) are 46% of the dispatch runtime and are the blocks the three questions
above most strongly justify. They are justified *conditionally*, on the observed
fact that executors fail in ways a wrapper must catch. Building the instrument —
a recovery-rate readout over vNext runs — is the prerequisite for ever retiring
them, and it now needs nothing but vNext runs to read.

## The stopping condition

The harness stops being worth it when the failures it prevents stop happening.
Not when a stronger model *could* do the work — a stronger model still cannot
resume its own dead process — but when the measured rate of the specific
failures each block was built for falls to near zero.

So the answer to "at what complexity" is: complexity is not the variable.
**Unjustified** complexity is. A 20,000-line harness whose every block maps to a
failure observed this quarter is worth keeping; a 5,000-line harness where half
the blocks were built for failures nobody has seen in a year is not. Tripwire C
is the one to keep watching, because it is the one that will eventually fire.
