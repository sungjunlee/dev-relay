# Relay Review Runner Notes

`scripts/review-runner.js` is a single Relay path. It does not read mutable
lifecycle records, legacy event formats, rubric snapshots, PR-body score logs,
execution-evidence sidecars, review budgets, or mutable round state.

## Resolution

Use exactly one of:

```bash
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --json
node skills/relay-review/scripts/review-runner.js --repo . --run-dir <absolute-run-dir> --json
```

The repository identity derived from the Git common directory and the selected
source route (GitHub identity, or the immutable local identity when no remote
exists) must equal `run.json`. Local review requires no forge observation;
GitHub review requires the exact live PR identity and explicit reviewer
credentials/network access. The runner reads Done Criteria only from the frozen
run-local path and verifies its hash through `run-store`.

## Inputs and artifacts

Before invocation, canonical `inspect` must report `recommended_action.kind=review`.
For local delivery, fresh clean Git `HEAD`/tree and the latest passed
`verification_recorded` fact must bind the derived head and frozen Done Criteria
hash, with no durable PR fact. For GitHub delivery, the live PR number/head
must equal the latest durable `pull_request_recorded` fact and derived head.

In operator terminology, the Git repository and immutable `start_sha` are the
Source; the exact GitHub PR is the current Change Request when that route is
used. The runner derives the ReviewSubject without adding a runtime object:
SHA-1 object format, `start_sha` base OID, exact fresh Git reviewed head OID (or
exact live/durable PR head), the passed
verification tree OID, the binary diff digest, and the frozen Done Criteria
digest. The resulting Reviewed Result is terminal proof of exact verification
and independent review; it does not imply Publication or Landing. Landing
remains a separate explicit merge operation.

The runner writes content-addressed immutable inputs below `review-inputs/`:

- `diff-<sha>-<digest>.patch`
- `prompt-<sha>-<digest>.md`

The diff digest is exactly SHA-256 over the immutable newline-normalized output
of `git diff --binary --no-ext-diff <start_sha>..<head> --`. No
`--full-index` or alternate patch format is implied.

The durable result is `review-<round>-<digest>.json`. For local delivery only,
it projects the exact verification event id and immutable run digest alongside
the existing reviewed SHA and input digests; GitHub schema-v2 artifact bytes
retain their existing shape. Its matching `review_recorded` fact stores the exact
reviewed SHA, Done Criteria hash, reviewer binding, derived round, verdict, and
artifact path. Canonical local closure revalidates the content-addressed
artifact and fresh binary diff under the recovery lock. Orphaned immutable
input/result files after a crash do not authorize lifecycle progress; only the
fact does.

Immediately before staging, the runtime re-hashes the content-addressed prompt
and diff against the caller's initial digests and verifies frozen Done Criteria
bytes against `run.json`. The reviewer receives only the direct, contained
staged diff/prompt/criteria/schema paths and a separate output child; the
bundle never contains an executor transcript. The trusted-local direct process
is not a Relay filesystem sandbox and can otherwise read what its local user
can read. After execution, the runtime re-binds every staged file before it
parses output, then the runner re-hashes durable inputs under the append lock.
A source/head swap or staged-input mutation, drift, or containment violation
fails as `REVIEW_INPUT_BINDING_CHANGED` and writes no review fact rather than a
retryable runtime escalation.

## Concurrency

The expensive reviewer call holds a dedicated per-run execution lock. This gives any uncertain process cleanup a signed recovery authority before the exact staged input root can be removed. Persistence later acquires a new per-run lock generation, re-runs inspection, and refuses any changed action, delivery, or head/tree. Concurrent review attempts therefore converge to at most one fact. Nothing is serialized repository-wide: unrelated runs in one repository proceed independently.

## Direct adapter invocation

Primary review uses `adapter.buildInvocation({ phase: "primary_review", ... })` directly. Legacy `invoke-reviewer-*` wrappers are not part of this path. The runtime stages criteria, diff, prompt, schema, and result paths, launches the actual CLI directly on the trusted local host, and delegates result parsing to `adapter.parseOutcome`. An adapter's native read-only control is requested where it has one; Relay itself does not claim filesystem isolation.

Codex and Claude receive the staged JSON schema through native structured-output flags. OpenCode, Pi, Antigravity, and Cursor receive the same closed schema in the staged prompt and their raw JSON is validated by the shared adapter result parser. Cline advertises primary review as unsupported.

The review environment allowlist excludes `GH_TOKEN` and `GITHUB_TOKEN`. The
review bundle exposes no run directory, executor worktree, dispatch prompt,
transcript, or session state, although a direct trusted-local CLI is not
prevented from independently reading user-accessible files outside that bundle.

A runtime invocation failure is classified in its durable review fact and may
derive one explicit `review` retry with `retry_of_event_id` bound to that fact.
The runner rechecks the immutable run digest, exact review binding, and retry
subject under the run lock. A second failure and model-returned escalation both
fail closed; Relay never starts an automatic retry loop.

Reviewer authentication uses the operator's ambient local CLI HOME/XDG/config
and supported auth environment. Relay does not copy credentials, rewrite
HOME/XDG, or serialize credentials/source paths in artifacts, argv, facts, or
diagnostics. It still stages and binds only the immutable review inputs; that
exact staged-input root is removed after process settlement and is the sole
non-process recovery resource.

## Removed options

Unknown options fail through `util.parseArgs`. In particular, Relay has no `--review-file`, `--reviewer-script`, `--prepare-only`, `--detach`, `--wait-for-checks`, `--no-comment`, `--pr`, `--branch`, review-budget, assurance, or reviewer-swap flags.
