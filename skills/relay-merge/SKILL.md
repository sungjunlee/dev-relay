---
name: relay-merge
argument-hint: "[run-id]"
description: Explicitly merge a Relay run after exact-SHA independent review, record provenance, and clean up its retained worktree.
compatibility: Requires gh CLI, git, and Node.js 22+; external merge observation uses the direct trusted-local host on supported OSes.
metadata:
  related-skills: "relay, relay-ready, relay-plan, relay-dispatch, relay-review, dev-backlog"
  keywords: "머지, 병합, merge, finalize, cleanup"
---

# Relay Merge

Use only for the supported GitHub route after `relay-review` records a passing verdict. A
local Reviewed Result closes through canonical recovery and never enters this
skill. Merge remains an explicit operator action; review bypasses and mutable-state overrides are not
part of the Relay contract.

## Inputs

- An immutable Relay `run.json` and append-only `events.jsonl`.
- The retained run worktree and its exact open PR.
- `--run-id` or an explicit `--run-dir`.
- Optional opaque operator identity, merge method, and operation id.

## Process

### 1. Read-only gate

```bash
RUN_ID=<run-id-from-dispatch>
node "${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/gate-check.js" \
  --repo . --run-id "$RUN_ID" --json
```

The gate calls canonical Relay `inspect` and fails closed unless all of these
identify the same commit:

- live GitHub PR head and remote branch;
- retained worktree HEAD and Git tree;
- durable PR fact;
- passing verification fact;
- independent review fact and frozen Done Criteria hash.

If the derived action is not `merge`, follow that action. Never synthesize a
merge override from a PR comment, retired state, or missing evidence.

### 2. Explicit merge and cleanup

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/finalize-run.js" \
  --repo . --run-id "$RUN_ID" --merge-method squash --json
```

`finalize-run.js` repeats inspection after run-lock acquisition, issues a
durable merge authorization, invokes GitHub, revalidates
the exact merged PR, and appends one `merge_recorded` fact. It then removes the
clean linked worktree. A dirty, changed, unregistered, or repository-mismatched
worktree is retained rather than forced away.

The authorization and merge receipt make retries idempotent across crashes.
Re-run the same command, with the same actor and method, after an interruption.
Durable authorization values are authoritative; changing either value fails
before another GitHub merge request. Use `--operation-id <id>` when
an operator needs a stable externally recorded correlation id. `--no-cleanup`
retains the worktree intentionally; a later ordinary rerun performs terminal
cleanup without merging again.

GitHub may accept the request into a merge queue while the PR remains open.
That returns `status: merge_pending`; reruns observe the durable pending
request without submitting it again, and record the merge only after GitHub
reports the exact reviewed head as merged.

Immediately before the external call, finalize fsyncs an immutable request
intent. If a crash leaves that intent but GitHub proves neither the exact merge
nor a queued request, finalize fails with an ambiguous-outcome error and
requires canonical recovery instead of risking a duplicate call.

The final preflight rechecks the immutable configured base and source SHA.
GitHub review stages its patch from the live reviewed base with three-dot
semantics, so a required pre-review base update does not attribute base-only
paths to the branch. If the base commit advances after review, finalize requires
the reviewed base to be its ancestor and compares the exact reviewed Git path
set with GitHub's base advance paths. Zero overlap remains mergeable; overlap
fails typed and requires updating the branch onto the current base, then
canonical verification. The ensuing re-review uses that new live PR base as
the three-dot left side and therefore stages only branch-unique changes. Path
overlap is a proxy, so semantic conflicts across different paths remain outside
this proof. GitHub compare caps file evidence at 300 entries; that boundary and
incomplete commit pagination fail closed.

The
GitHub merge API provides an atomic expected-source-SHA guard
(`--match-head-commit`) but no expected-base compare-and-swap. Therefore a base
retarget detected before the request fails closed, while the remaining
post-check/pre-request base nanorace—in which an external collaborator changes
PR metadata—is a documented GitHub platform threat boundary, not a weakened
source-SHA or configured-base invariant.
Merge-queue/base movement after a request is rechecked on resume, but Relay
cannot undo an externally completed merge.

### 3. Optional post-merge project updates

`append-learnings.js` and dev-backlog sprint updates are separate project
mutations. Run them explicitly after `finalize-run.js` returns `status: merged`;
they are not part of the merge transaction.

See [`references/append-learnings.md`](references/append-learnings.md) for the
marker-bounded learning writer and
[`references/operator-emergencies.md`](references/operator-emergencies.md) for
recovery guidance. Serialized full-suite gate guidance lives in
[`references/full-gate.md`](references/full-gate.md).
