# Base movement between review and merge — measurement (#1174)

Measured 2026-08-07 against `~/.relay/runs/*/*/events.jsonl` and the local git
histories of the corresponding repositories. This is the measurement phase of
issue #1174; no mechanism is implemented here.

## Question

Review and verification bind head, tree SHA, and the frozen Done Criteria hash.
Nothing binds the **base**. Between the review fact and the merge fact the base
branch can advance, and the class that broke `main` in the #890 × #897
incident is precisely a base advance that touches files the reviewed PR
touches. Before choosing a mechanism, #1174 asks for the distribution.

## Method

- Fold every `events.jsonl` under `~/.relay/runs/` for `review_apply` →
  `merge_finalize` pairs (legacy schema, `event`/`ts`) and `review_recorded` →
  `merge_recorded` pairs (vNext schema, `type`/`at`). The dual-schema fold
  matters: a single-schema fold silently drops the other generation.
- vNext contribution is currently **zero pairs**: only 7 vNext run directories
  exist and none has reached review/merge (they are dispatch/canary runs). All
  581 measured pairs are legacy. This is itself a finding — see below.
- For each pair: `B_review` = `main` HEAD at the review timestamp, `B_merge` =
  `main` HEAD at the merge timestamp (committer dates, `--first-parent`).
- The run's own merge commit (closest committer time to the merge timestamp)
  is excluded from the "base advance" set; a merge whose only new main commit
  is its own is counted as *not moved*. Self-check: the own merge commit's file
  set matches the retained review patch 268/269 times, so the identification
  method is sound.
- Overlap = any advance commit touches a file in the PR's review patch file set
  (`review-round-<n>-diff.patch` from the last passing round).

## Distribution

| repo | pairs | base moved | overlapping advance |
| --- | ---: | ---: | ---: |
| dev-relay-778886da | 274 | 40 (14.6%) | 4 |
| tamgu-note-17584680 | 82 | 20 (24.4%) | 7 |
| beopjalal-52dbe4b5 | 66 | 6 (9.1%) | 1 |
| dear-scene-06a79755 | 31 | 0 | 0 |
| dev-backlog-ceca3b0f | 24 | 3 (12.5%) | 3 |
| tamgu-ai-lab-c7e3d750 | 24 | 5 (20.8%) | 0 |
| baby-ops-4c92329b | 23 | 7 (30.4%) | 6 |
| aibris-a92d7479 | 22 | 1 (4.5%) | 0 |
| survival-alpha-ce9e4441 | 21 | 1 (4.8%) | 1 |
| beopjalal-a711af4b, dear-scene-relay-repo-268, dev-relay-f573fc6e, investanza, money-animal, craftkit, yookahyu-calc | 14 | 0 | 0 |
| finjuice-9621f35f | 0¹ | — | — |
| **TOTAL** | **581** | **83 (14.3%)** | **22 (3.8%)** |

¹ finjuice has no usable `main` history (single "Initial public release"
commit); its run dirs are excluded from the correlation.

Review→merge window: median 1.0 min, mean 90.3 min, max 5,888 min (4 days).
75 of 274 dev-relay windows exceed 10 minutes.

## The dangerous class is real and it clusters

22 of 581 merges (3.8%) had a base advance that touched a file the reviewed PR
touched. The clearest empirical instance of the #890 × #897 shape is
dev-backlog, where three consecutive runs — issue-35 (PR #38), issue-36
(PR #41), issue-37 (PR #40) — merged within 13:15–13:24 on 2026-04-07, each
green on its own base, all three touching `progress-sync.js`. issue-37 even
merged `main` into itself before merging (the healthy pattern) while the other
two did not.

Other short-window collisions: baby-ops issue-151 (1.1 min, `src/app/index.tsx`),
tamgu-note issue-2031 (4.0 min, CHANGELOG + feature flags), dev-relay
issue-765 (8.0 min, `docs/script-inventory-and-cleanup.md`), dev-relay
issue-1099 (276 min, `dispatch.js` + its test).

Whether any of these 22 actually regressed the merged state is not determined
here — file overlap is a proxy for semantic conflict, not proof of it. The
measurement's job is the distribution and the false-positive cost.

## Mechanism recommendation, with the cost in both directions

**Reject the hard pin.** A review-time base SHA that blocks merge whenever it
moves would have refused 83/581 merges (14.3%), of which 61 (73.5% of the
refusals) were benign non-overlapping advances — the constant liveness tax the
issue predicted, now measured. This matches the #1152 precedent where
measurement rejected the same trade.

**Adopt the overlap-based check** (base moved AND an advance commit touches a
file the reviewed PR touched → do not merge silently; require operator
adjudication or a fresh verification against the current base):

- Flag rate on this corpus: 22/581 = 3.8%, all with a concrete, nameable
  collision file. No false positives on the non-overlapping 61.
- It cannot prove semantic conflict — two unrelated edits to one file can merge
  cleanly — so the flag must surface rather than hard-fail, unless the
  subsequent CI/verification run against the moved base is made mandatory.
- Residual miss: a semantic conflict with zero shared file paths (interface
  contracts, generated code, behavioral contracts) escapes a file-level check.
  That residual is smaller and rarer than the #890 × #897 class; record it as a
  known bound rather than widening the mechanism into a general conflict
  detector.

**Advisory surfacing is the fallback** if the overlap check's 3.8% is judged
too noisy for this operator: print at merge time "base advanced N commits since
review, touching M of your files" and let the operator decide. It keeps the
fail-open gap for inattentive operators, which is exactly the #890 × #897
failure mode, so overlap-check is preferred.

## Data-model finding (blocks native enforcement)

Neither schema records a base SHA at review time:

- Legacy `review_apply` carries `head_sha` only.
- vNext `review_recorded` (per the reset contract) carries `reviewed_sha` only;
  `merge_recorded` carries `result_target_sha` (the post-merge target) but
  nothing to compare it against from the review side.

This measurement was only possible by cross-referencing the local git histories
of the repositories — the runtime cannot answer its own question. Before any
mechanism ships, `review_recorded` must record `base_sha` (frozen at review,
same immutability as `done_criteria_sha256`), and the merge gate must re-read
the live base and compute the advance + overlap set. The measurement also
cannot be re-run from vNext data until such runs exist.

## Reproducibility

The fold logic is in this session's working transcript (Python, reads
`~/.relay/runs/*/*/events.jsonl` and `git log --first-parent` per repo). It is
not committed as a repo script because it reads orchestrator-local run data;
the method above is the spec an implementation would encode as a ledger test
against a fixture corpus.
