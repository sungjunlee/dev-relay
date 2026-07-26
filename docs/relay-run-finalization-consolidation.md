# Relay Publication-Primitive Consolidation — Design Proposal

**Status:** Proposal, revised 2026-07-26 after independent multi-model review.
**Scope changed:** an earlier revision of this document proposed a single convergent
`finalizeRun()` replacing three finalization paths. **That design was reviewed by three independent
models (GPT-5.6 Sol, Grok 4.5, Codex) and unanimously rejected.** The refutation is preserved in
[Appendix A](#appendix-a--the-rejected-design-and-why) because the reasoning is the useful part.

Successor question to [relay-instruction-altitude-prd.md](relay-instruction-altitude-prd.md)
(Issues A+B shipped in PR #1081).

## Bottom line

Relay has **two implementations of "push the branch and open a PR."** They have already drifted,
and the drift is a live defect. The right move is to consolidate that one **publication primitive**
— not to unify run finalization, which would relocate complexity rather than remove it.

## Why not the observation gate

The Instruction Altitude PRD gated **Issue C** ("retire `recover-commit` / evidence rebrand") behind
an observation window: watch the misbehavior tax trend to zero, then delete the machinery.

That gate will not open, but **not for the reason first proposed here.** The honest reason is not
"`recover-commit` is an entry point" — it is that **the fallback is retained by design**:
`dispatch.js` still shells out to `recover-commit.js` when the orchestrator commit fails
(`dispatch.js:3443-3460`), and `reconcile-run.js:238` calls it too. A tax that is structurally
reachable will not read as zero.

There is also a cheaper alternative the earlier draft under-weighted: if the tax does approach zero,
the *auto* path can simply be disabled while `recover-commit` is demoted to an operator-only CLI.
That achieves much of Issue C's goal without any consolidation.

## The actual defect: one publication primitive, two implementations

`dispatch.js` and `publish-run.js` share `pushAndOpenPR` (`dispatch.js:3353`, `publish-run.js:210`
→ `dispatch-publish.js:70`). `recover-commit.js` shares only `parsePrNumber` and reimplements the
rest: `gh pr list` (`:315`), `git push` (`:664`), a second `gh pr list` (`:672`), `gh pr create`
(`:689`).

### Verified divergences

| Dimension | shared `pushAndOpenPR` | `recover-commit` | Verdict |
| --- | --- | --- | --- |
| **PR base** | explicit `--base`/`--head` (`dispatch-publish.js:119-125`) | **omits both** (`:689`) | **Defect.** Base falls back to the GitHub default branch, ignoring `manifest.git.base_branch`. Wrong-target PR on any non-default base. |
| **Remote** | `resolveBranchRemote` → `branch.<b>.remote`, origin fallback (`dispatch-publish.js:55-68`, #229) | hardcoded `origin` (`:664`, `:527`) and in unpushed detection (`:303-304`) | **Defect.** #229's fix reached one push site out of five. |
| PR title | `git log -1 %s` (`:109`) | explicit → issue title → branch-inferred → fallback (`:118-151`) | **Intentional — preserve** |
| PR body | dispatch summary (`:34-53`) | recovery audit body + `--pr-body-file` (`:153-165`) | **Intentional — preserve** |
| Existing-PR probe | once, before push (`:83-93`) | twice, incl. **after** push (`:489`, `:672`) | **recover is safer** — absorb into shared |
| Push gating | always pushes (`:98`) | conditional on PR/dirt/unpushed (`:661`) | **Intentional** (re-run hygiene) |
| `internal_review_pending` | n/a | skips push/PR entirely (`:624-658`) | **Intentional — required** |
| PR-number persistence | caller writes, unlocked | `stampPrNumberUnderLock` (`:706-738`) | **Intentional** |

The lesson: the publish *block* is not uniformly duplicated. A narrow slice (push + PR create) is
genuinely redundant and has drifted; the surrounding policy is deliberate and must survive.

### Remote hardcoding is systemic

`origin` is hardcoded at `recover-commit.js:527,664` and `:303-304`, `reconcile-run.js:388`, and
`rebrand-evidence.js:186`. Only `dispatch-publish.js:98` resolves the branch remote. This reframes
#229 as **incompletely landed** rather than as a `recover-commit` quirk.

## Proposal

Consolidate the **publication primitive only**:

1. Let `pushAndOpenPR` accept explicit `title` / `body` overrides, keeping the dispatch builders as
   defaults — this is what lets `recover-commit` keep its issue-derived title and audit body.
2. **Always pass `--base` and `--head`** on PR creation, sourced from `manifest.git.base_branch`.
3. On a "PR already exists" create failure, re-query by head branch and converge to success —
   promoting `recover-commit`'s safer two-probe behavior into the shared path.
4. **Share remote resolution** for push *and* unpushed-commit detection, completing #229 across all
   five sites.
5. Only the **immediate-publication** recovery path calls the shared publisher. Commit policy,
   evidence policy, manifest/state transitions, locking, and escalation stay with each caller.

**Explicitly out of scope:** commit sequencing, evidence ordering, state transitions, and
`reconcile-run`. Callers keep owning transitions — target states differ per caller
(`review_pending` / `internal_review_pending` / `escalated`) and must pass `validateTransition()`.

### Expected impact

Production net change is small (roughly −20 to +50 lines), but it removes **one real concept**:
"two push/PR implementations." Compare the rejected design at roughly −100 to +150 production lines
plus 400–800 lines of new partial-state tests, for a concept count that *increases*.

## Defects found during this review (fix independently of the refactor)

These were surfaced by review and are worth filing on their own merits:

1. **Wrong PR base** — `recover-commit.js:689` omits `--base`; recovery PRs open against the
   repository default branch, not `manifest.git.base_branch`.
2. **#229 landed on 1 of 5 push sites** — see the hardcoding list above.
3. **Stale `git.head_sha`** — when a run is already `review_pending` *and* `git.pr_number` is set,
   neither stamping branch fires (`recover-commit.js:705`, `:733`), so no manifest write occurs and
   `head_sha` stays stale even though a new commit was created. The existing idempotency test
   (`recover-commit.test.js:1096`) uses a clean worktree, so this path is uncovered.
4. **Lease/reconcile race** — the run lease is removed before finalization completes, so
   `reconcile-run` can act concurrently; the manifest lock is not a CAS.
5. **`reconcile-run` row 6** — publishes in a way that does not respect the run's publish policy.

## Appendix A — the rejected design, and why

**The rejected proposal:** one idempotent `finalizeRun()` establishing
`committed → pushed → PR → evidence bound to final SHA → manifest stamped`, with `dispatch`,
`recover-commit`, and `publish-run` as thin callers. Its headline claim was that writing evidence
last would make the internal evidence rebrand **structurally unreachable**, achieving Issue C's goal
by construction and with no observation window.

**Why it was rejected** — all three reviewers converged independently:

1. **The headline claim is false.** `reconcile-run.js:443` calls `rebrandEvidence()` directly, and
   `rebrand-evidence.js:363` is an operator correction path. Reordering dispatch's writes cannot
   make a function unreachable that two other callers invoke on purpose. Worse, a finalizer that
   supports partial states with stale evidence needs a preserving rebrand *itself*.
2. **It relocates complexity.** To serve all three callers the finalizer must expose
   `publish:false`, `transition:caller`, `existingEvidencePolicy`, `operatorEvidence`,
   `PRMetadataPolicy`, `supersedeGuard`, `stampMode`, and `escalationPolicy` — "a module that
   transmits complexity rather than hiding it."
3. **The invariant is not shared.** Delayed dispatch deliberately stops at
   `internal_review_pending` without pushing (`dispatch.js:3333-3346`); `publish-run` requires a
   clean, reviewed HEAD and never commits (`publish-run.js:157-176`); `recover-commit` skips
   publication in internal-review mode (`:461`, `:624`). There is no single finalization contract.
4. **It would have deleted intentional behavior** by treating the whole publish block as duplication
   (see the divergence table).
5. **The invariant was incomplete anyway.** The hardened merge gate requires not just the evidence
   file but a *trusted event* binding its hash (`review-gate.js:344-367`, `:577-597`), so the real
   ordering is `evidence → trusted event → state exposure`. Dispatch currently writes that event
   *after* the manifest (`dispatch.js:3440` → `:3505`) — a crash window the proposal never addressed.
6. **A claimed side benefit did not follow.** Consolidation would not dissolve executor gating for
   auto-commit; that is policy driven by executor identity and explicit opt-out
   (`dispatch.js:509-513`).

**Corrections to earlier claims in this document, for the record:**

- `rebrand-evidence.js` should be kept (correct), but the description "does not commit/push/PR" is
  true only of its default path — `--rebase-onto-base` fetches, rebases, and force-pushes
  (`rebrand-evidence.js:147-187`).
- `reconcile-run.js` should not be folded in (correct), but calling it "a different axis" is only
  half true: row 4 invokes `recover-commit` (`:916-947`) and row 6 performs the same
  publication/evidence work (`:295-301`, `:614-659`).
- An even earlier framing claimed ~1,180 deletable lines (`recover-commit` + `rebrand-evidence`).
  That was wrong: `rebrand-evidence.js` is operator-correction tooling, not tax machinery.
