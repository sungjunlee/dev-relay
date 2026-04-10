# Relay Scenario Tests

Scenario matrix for the same-run lifecycle and reliability scorecard wave.

## Goal

Exercise the implemented same-run lifecycle, intake request persistence, fresh merge gate, append-only events, explicit close path, and derived reporting.

## Current Coverage

### 1. Dispatch dry-run emits run metadata

Command:

```bash
node skills/relay-dispatch/scripts/dispatch.js . -b issue-42 --prompt "test prompt" --dry-run --json
```

Expect:

- `runId`
- `manifestPath`
- `cleanupPolicy`

### 2. Dispatch success writes manifest and ends in `review_pending`

Command:

```bash
python3 skills/relay-dispatch/scripts/smoke_dispatch_scenarios.py
```

Scenario:

- create a temp git repo
- dispatch a worker that creates `smoke.txt` and commits it

Expect:

- command exit code `0`
- `runState: review_pending`
- manifest contains `state: 'review_pending'`
- manifest contains `cleanup: 'on_close'`
- `~/.relay/runs/<repo-slug>/` contains the run manifest
- dispatched worktree still exists after the command returns
- harness explicitly removes the retained worktree during teardown

### 3. Dispatch no-op failure writes manifest and ends in `escalated`

Command:

```bash
python3 skills/relay-dispatch/scripts/smoke_dispatch_scenarios.py
```

Scenario:

- create a temp git repo
- dispatch a worker that inspects only and makes no changes

Expect:

- command exit code non-zero
- `runState: escalated`
- manifest contains `state: 'escalated'`
- manifest contains `cleanup: 'on_close'`
- dispatched worktree still exists after the command returns
- harness explicitly removes the retained worktree during teardown

### 4. Skill frontmatter is valid YAML

Command:

```bash
for f in skills/*/SKILL.md; do
  python3 - <<'PY' "$f"
import sys, pathlib, yaml
p = pathlib.Path(sys.argv[1])
text = p.read_text()
end = text.find('\n---\n', 4)
yaml.safe_load(text[4:end])
print(p)
PY
done
```

Expect:

- all skill files parse as YAML

### 5. Manifest resolver and state helper update the intended run

Command:

```bash
node --test skills/relay-dispatch/scripts/update-manifest-state.test.js
```

Expect:

- `run_id` resolves the intended manifest directly
- ambiguous branch-only lookup fails instead of silently picking the newest run
- helper updates `review_pending -> ready_to_merge`
- helper persists `git.pr_number`, `git.head_sha`, `review.rounds`, `review.latest_verdict`, and `review.last_reviewed_sha`

### 6. Same-run dispatch resume reuses the retained worktree

Command:

```bash
node --test skills/relay-dispatch/scripts/dispatch.test.js
```

Expect:

- a run in `changes_requested` resumes on the same worktree and manifest
- re-dispatch keeps the same `run_id`
- missing retained worktrees fail loudly without creating a replacement run
- intake-linked runs can resume only with the exact same `request_id`, `leaf_id`, and `done_criteria_path`
- issue-first runs cannot gain relay-intake linkage retroactively during resume

### 7. Review runner validates structured verdicts and updates manifest state

Command:

```bash
node --test skills/relay-review/scripts/review-runner.test.js
```

Expect:

- `--prepare-only` writes the round prompt bundle without changing manifest state
- a pass verdict updates `review_pending -> ready_to_merge`
- a changes-requested verdict updates `review_pending -> changes_requested`
- changes-requested verdicts write a targeted `review-round-N-redispatch.md`
- `--reviewer-script <path>` can drive the round without a separate `--review-file`
- reviewer-written diffs are rejected and escalate the manifest with `latest_verdict=policy_violation`
- retained-worktree-vs-repo-root divergence is covered
- max-rounds enforcement is covered
- repeated identical issues escalate on the third consecutive round
- malformed verdicts are rejected instead of guessed

### 8. Codex skill strict validation is still a known mismatch

Command:

```bash
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/relay-review
```

Current result:

- fails on extended frontmatter keys such as `argument-hint`, `compatibility`, `context`

Interpretation:

- this is a repo-wide skill-format mismatch with the strict Codex validator
- it is not a regression from the manifest foundation work
- the actual YAML syntax issue in `relay-review/SKILL.md` is fixed

### 8a. Intake request persistence rejects frozen-snapshot collisions

Command:

```bash
node --test skills/relay-intake/scripts/request-store.test.js
```

Expect:

- reusing the same `request_id` fails before any request artifact is overwritten
- the original frozen Done Criteria snapshot stays unchanged
- the request event log remains append-only with the original two persistence events only

### 9. Optional live adapter verification

Commands:

```bash
node skills/relay-review/scripts/invoke-reviewer-codex.js --repo /tmp/review-fixture --prompt-file /tmp/review-prompt.md --json
node skills/relay-review/scripts/review-runner.js --repo /tmp/review-fixture --branch issue-42 --pr 123 --done-criteria-file /tmp/done.md --diff-file /tmp/diff.patch --reviewer codex --no-comment --json
node skills/relay-review/scripts/invoke-reviewer-claude.js --repo /tmp/review-fixture --prompt-file /tmp/review-prompt.md --json
```

Current result:

- live `codex` adapter invocation returns schema-valid JSON
- live `review-runner --reviewer codex` can promote `review_pending -> ready_to_merge`
- live `claude` adapter wiring is fixed, but the local machine still needs an authenticated `claude` CLI session

### 10. Merge finalizer records cleanup success or failure

Command:

```bash
node --test skills/relay-merge/scripts/finalize-run.test.js
```

Expect:

- a clean retained worktree is removed after merge finalization
- the merged local branch is deleted
- stale or missing review blocks merge even when the manifest says `ready_to_merge`
- explicit skip-review with a reason is allowed and audited
- manifest state stays `merged` while `cleanup.status` becomes `succeeded`
- dirty retained worktrees are preserved and become `manual_cleanup_required`

### 11. Close-run explicitly terminates stale non-terminal runs

Command:

```bash
node --test skills/relay-dispatch/scripts/close-run.test.js
```

Expect:

- non-terminal runs can transition to `closed` with a required reason
- close appends lifecycle evidence and runs cleanup policy
- dirty worktrees stay explicit follow-up

### 12. Reliability report derives the initial scorecard from raw history

Command:

```bash
node --test skills/relay-dispatch/scripts/reliability-report.test.js
```

Expect:

- the report derives the initial 5 metrics from manifests + events only
- no aggregate counters are stored in the manifest

### 13. Repo-local janitor cleans stale terminal runs only

Command:

```bash
node --test skills/relay-dispatch/scripts/cleanup-worktrees.test.js
```

Expect:

- stale `merged` runs are cleaned via their manifest metadata
- stale non-terminal runs are reported with an explicit `close-run.js` command
- cleanup results are written back to the manifest

### 14. Live Codex-as-orchestrator validation report

Report:

- [codex-orchestrator-e2e-validation-2026-04-03.md](./codex-orchestrator-e2e-validation-2026-04-03.md)

Covers:

- a no-sprint live run in `dev-relay`
- a sprint-enabled live run in the disposable GitHub fixture repo
- exact operator prompts, run IDs, manifest paths, PR/review URLs, merge SHAs, and known gaps

### 15. Raw request intake persists a relay-ready handoff and feeds downstream review anchors

Command:

```bash
node --test skills/relay-intake/scripts/request-store.test.js
```

Expect:

- `~/.relay/requests/<repo-slug>/<request-id>.md` is created
- request events append the portable intake event types plus `relay_ready_handoff_persisted` when a handoff is frozen
- `relay-ready/<leaf-id>.md` and `done-criteria/<leaf-id>.md` are created for relay-ready leaf tasks
- multi-leaf input persists ordered child handoffs with per-leaf Done Criteria snapshots
- dispatch can record `source.request_id`, `source.leaf_id`, and `anchor.done_criteria_path`
- `review-runner --prepare-only` loads the frozen snapshot from the manifest anchor without re-fetching GitHub issue text

### 15a. Directly relayable standalone request persists immediately

Covered by the same command as Scenario 15.

Expect:

- a single clear `raw_text` request with stable Done Criteria can call `persistRequestContract(...)` immediately
- no proposal or question events are required first
- the request artifact lands directly in `state: relay_ready` with `next_action: relay_plan`

### 15b. Ambiguous request shapes through proposal, question, answer, acceptance, then persistence

Covered by the same command as Scenario 15.

Expect:

- intake records `proposal_presented -> question_asked -> question_answered -> proposal_accepted`
- `next_action` moves through the conversational steps before final persistence
- the same `request_id` can then be promoted into a frozen relay-ready handoff

### 15c. Oversized request uses proposal-first decomposition before freezing a handoff

Covered by the same command as Scenario 15.

Expect:

- an oversized request records an initial proposal and a decomposition proposal with `structure_kind: decompose`
- the accepted proposal still leaves the artifact in intake until relay-ready handoff persistence happens
- `next_action` stays lightweight; no second intake state machine is introduced

### 15d. Decomposed request persists ordered child handoffs

Covered by the same command as Scenario 15.

Expect:

- multi-leaf handoffs are persisted in execution order even if the input order differs
- per-leaf `depends_on` metadata survives into the relay-ready artifacts
- the parent request artifact records `decomposition.leaf_order` and dependency mapping

### 15e. Non-issue request freezes generated Done Criteria from the handoff

Covered by the same command as Scenario 15.

Expect:

- `source.kind: raw_text` persists without any GitHub dependency
- the frozen Done Criteria snapshot comes from `handoff.done_criteria_markdown`
- the relay-ready handoff points back to that generated snapshot path

### 15f. Plain-text `A/B/C + free text` protocol works without host widgets

Covered by the same command as Scenario 15.

Expect:

- `response_options` are persisted as plain string arrays
- proposal and clarification flows remain usable without buttons, cards, or other host-specific UI
- answers can still be recorded as plain text plus an optional `answer_choice`

### 15g. Delegate fallback keeps portable intake events working

Covered by the same command as Scenario 15.

Expect:

- `structure_kind: delegate` persists as a normal intake event
- the delegate fallback can still be accepted with `proposal_accepted`
- no host-specific routing or production-code special case is required

### 15h. Issue-first fast path bypasses intake overhead when the request is already relay-ready

Covered by the same command as Scenario 15.

Expect:

- `source.kind: github_issue` can persist directly to `relay_ready`
- only `request_persisted` and `relay_ready_handoff_persisted` are needed in the fast path
- the frozen Done Criteria snapshot still exists so downstream review has a stable anchor
