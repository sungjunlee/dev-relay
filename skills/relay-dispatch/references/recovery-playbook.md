# Recovery Playbook

Relay has one recovery surface. `inspect` is byte-read-only and derives one
typed next action from immutable run facts plus live Git/GitHub observation.
`recover` re-observes under the run lock and converges that action idempotently.
In the shared vocabulary, recovery-owned Publication places the exact Source
revision on a remote ref. It is not Change Request creation and does not imply
Landing. The source gate permits either a no-remote local Git route or the
existing identity-matching GitHub route. Local recovery never calls a forge or
remote transport and closes a reviewed result through the canonical
`close_reviewed_result` action; GitHub recovery retains its exact PR publication
and Change Request behavior. Unsupported remotes fail closed.

```bash
node skills/relay/scripts/relay-recover.js inspect \
  --repo . --run-id <id> --json

node skills/relay/scripts/relay-recover.js recover \
  --repo . --run-id <id> \
  --expected-action-key <key-from-inspect> \
  --reason "operator explanation" --json
```

When `inspect` reports `review_escalated`, use the reported review event id to
record an explicit adjudication. `re_review` authorizes exactly one fresh review
of the same subject; `redispatch` enters the same correction lifecycle as
`changes_requested`. Neither disposition is a passing review.

```bash
node skills/relay/scripts/relay-recover.js recover \
  --repo . --run-id <id> --reason "operator adjudication" \
  --resolve-review re_review --review-event-id <review-event-id> --json

node skills/relay/scripts/relay-recover.js recover \
  --repo . --run-id <id> --reason "operator adjudication" \
  --resolve-review redispatch --review-event-id <review-event-id> --json

node skills/relay/scripts/relay-recover.js recover \
  --repo . --run-id <id> --reason "superseded" --close --json
```

All three exits append typed facts under the run lock. Do not edit
`events.jsonl`, create a replacement run, or supersede the PR merely to escape
a reviewer escalation.

Dispatch unwinds a branch/worktree pair when a caught failure occurs during
creation. A `SIGKILL` after `git worktree add` but before immutable `run.json`
creation cannot run that unwind, so the branch and registered worktree remain.
A same-branch retry returns typed `BRANCH_EXISTS` and preserves both.

```bash
git worktree list --porcelain
```

Relay cannot prove ownership of Git state created before `run.json`, so it does
not automatically remove that pair. Inspect the registry and retained checkout,
or dispatch with a new branch and run. `relay-recover` accepts only run selectors;
`--branch` is not a recovery surface.

Use `--run-dir <absolute-run-dir>` instead of `--repo` and `--run-id` only when
the canonical run directory is already known. Supply `--verification-file`
when the recommended action includes recording verification. Use
`--break-lock` only after `inspect` identifies a stale or unknown owner and the
authenticated terminal-result checks described in the output can succeed.

If cleanup reports `HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED`, the signed
obligation still names a live process but Relay can no longer prove its inherited
scope marker. Relay sends no signal in that state. The typed refusal payload
includes the exact `process_identity` and the signed cleanup artifact's validated
`terminal` context. Independently inspect the
reported `pid`, `pgid`, and `started_at`, terminate only that exact process using
an operator-controlled facility, then rerun the same canonical `recover
--break-lock` command. Do not kill by process name or reuse an old PID-only
command: the identity may have changed. Once the recorded identity is absent,
Relay signs cleanup settlement, publishes the terminal attempt result, and
continues recovery idempotently.
The refusal payload is advisory; the signed `cleanup-incomplete` artifact is the
authoritative source for its terminal context.

An unreceipted recovery intent normally remains `active_intent_pending` and is
resumed with the exact `action_key`, actor, and reason printed by `inspect`. The
ordered rules under the run lock are:

A MERGED PR binds through its durable recorded identity (`repo`, `pr_number`,
`head_ref`, and `base_ref`); its last recorded `head_sha` need not equal the
live `pr_head_sha`.

1. R1 — if the operation already has its exact `recovery_applied` completion
   (ordinary intent steps or the audited `active_intent_observation_changed`
   discharge), or its matching terminal fact, Relay validates/reuses it and
   writes the missing receipt. If every fact-emitting step already has its
   exact deterministic fact, Relay validates those facts, appends the missing
   `recovery_applied`, and writes the receipt. It never replays an effect.
2. R2 — if the fresh action is `recover` and every immutable intent step is in
   the fresh steps (a one-way, order-insensitive subset), Relay resumes exactly
   those immutable intent steps.
3. R3 — if the fresh action is still `recover` but the subset test fails,
   `inspect` recommends the typed `discharge_obsolete_intent` step with the
   same intent action key. Run `recover` with the intent's exact actor and
   reason. Relay appends an audited `active_intent_observation_changed`
   completion and masks the obsolete intent with its receipt. Discharge
   executes neither the obsolete steps nor the fresh action; inspect again and
   recover the newly derived action separately.
4. R4 — if the fresh action is not `recover`, Relay refuses the changed intent
   without executing or discharging it. Transient `operator_attention` stays
   here. Actor/reason mismatch and a fresh-key retry remain refusals with no
   writes.

To reproduce or base-control the recycled-PID refusal class, generic CPU load is
not sufficient: the race needs a same-window recycle of the specific freed
cleanup pid. Run the OpenCode cancellation test in a loop under CPU
oversubscription in an isolated worktree checked out at the exact SHA under
measurement, and bind the claim to the loop's exit predicate (fix tree: zero
failures across the loop; base tree: at least one reproduced failure within the
bounded loop). Ambient process churn dominates reproduction, so a zero-failure
base batch is a statement about the host at that moment, not about the defect.

- Measurement (2026-08-16, this host; 12 busy-loop CPU oversubscription;
  single-test loops of the OpenCode cancellation test):
  - Fix tree: 0 failures / 10 runs, plus earlier same-day batches of 0/10
    unloaded and 0/20 oversubscribed with fork churn — zero failures in 40
    total fix-tree runs.
  - Base `0f579a1` (isolated worktree): first reproduced failure at run 2 of a
    bounded 40-run loop; earlier same-day 20-run base batches under varying
    ambient churn measured 3/20 and 0/20. Reproduction tracks ambient process
    churn, as explained above.

## Safety contract

- Treat `run.json`, the fact journal, intents, receipts, and merge
  authorizations as writer-owned immutable artifacts; use only canonical
  inspect/recover operations.
- Treat `blockers` as fail-closed. Resolve the reported external condition and
  inspect again; do not force a lifecycle target.
- A CLOSED, unmerged exact PR is an operator decision, not permission to reuse
  or overwrite it. Open or select the intended PR explicitly, then inspect.
- Recovery commits only reviewable Git status paths. Ignored runtime files are
  outside recovery staging; reviewable sockets, FIFOs, and device entries block.
- GitHub merge reconciliation obtains an ephemeral token in the trusted parent
  from `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth login`, and discloses it only to
  the isolated observation process. Reviewer processes never receive it.
- Re-running the same action key returns the durable receipt without repeating
  effects. If live state changed, recovery returns a typed stale-action or
  active-intent blocker.

## Known limits of cleanup recovery

These are bounded, deliberate gaps. They are recorded so the cleanup guarantee is
not read as stronger than it is.

- Reviewer cleanup recovery discovers surviving processes by the sealed process
  scope, because the obligation is published before the reviewer child exists and
  therefore cannot name a pid. In-process cleanup reaps the exact process group and
  is unaffected. A reviewer CLI that scrubs its own scope marker and daemonizes can
  therefore outlive a `settled` publication. Credentials it already read are not
  revoked by stage deletion, so this is a liveness and accounting limit, not an
  additional disclosure path.
- The runtime binding is verified before and after execution, but exec resolves a
  pathname, so a swap-and-restore inside that window would run a different image
  than `executed_runtime` attests. Closing this needs exec-by-descriptor, which is
  not reachable from Node and would break signed CLI binaries. The precondition is
  write access to the reviewer CLI's own executable, which already implies control
  of the reviewer.
- A quarantine left behind by a failed removal whose rollback also failed is
  reclaimed on the next recovery by signed `dev`/`ino`, never by pathname. A
  sibling that does not match the signed identity is left untouched.
- Removal itself unlinks a pathname. Node exposes no `unlinkat`, so the verified
  inode cannot be bound to the delete any more than it can be bound to an exec.
  Every path-based step is therefore verified immediately before use, and settling
  additionally depends on a post-condition scan proving no tree carrying the signed
  identity survives under a quarantine name — a rename racing the delete fails
  closed instead of settling. The irreducible residue is a racing rename that also
  moves the tree out of the quarantine namespace; that requires write access to the
  run directory holding the credential stage, which already permits reading the
  staged bytes directly, so it grants no capability the attacker lacks.

The removed `reconcile-run`, `recover-commit`, `recover-state`,
`rebrand-evidence`, and `publish-run` command names are gone entirely.
`relay-recover.js` accepts only `inspect` and `recover`; every other verb exits
with `unknown operation`. No standalone legacy script is installed. Retired verbs and their target-state and force-policy flags fail closed: there is no alias, translation, or compatibility parser to accept them.
