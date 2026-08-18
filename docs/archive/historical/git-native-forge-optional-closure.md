# Git-native, Forge-optional Closure Evidence

Milestone 17 closes one narrow capability: an existing Git repository without
a remote may reach a terminal Reviewed Result. It does not turn Relay into a
non-Git executor, publication system, or generic forge framework.

| Evidence | Result |
| --- | --- |
| Implementation PRs | #1213 (#1209), #1223 (#1207), #1224 (#1208), #1226 (#1205) merged; #1206 closure is in flight in this PR. |
| Full local gate | Historical closure: 634 total, 632 pass, 0 fail, and 2 opt-in provider-canary skips (781.966 seconds). Those canaries were retired by #1234 and are not part of the current gate. |
| GitHub Actions | Historical closure PR: 9/9 required jobs green. #1232 PR #1238 later passed all 11 checks, including the Ubuntu trusted-local production-seam job. |
| Runtime baseline | `0f23fb2`: 16 files / 6,226 LOC → 16 / 6,845 (+619: milestone +540, interleaved hardening +79). |
| Test growth | Milestone test corpus: +1,465 lines before closure; this closure adds 389 test/fixture LOC (318 + 20 + 51). |
| Closure matrix | 6/6 scenarios green inside the final serialized gate: one uninterrupted journey plus five hard-exit/retry cuts. |

`tests/relay/scripts/git-native-closure.test.js` creates `git init` with no
origin and traps `gh`, `fetch`, `ls-remote`, and `push`. It calls public route
preflight, the dispatch CLI with a self-contained fake executor, canonical
recover for commit and exact verification, production `runReview`, and
canonical terminal close. The reviewer is fake only at the provider boundary;
the production review lock, immutable binding, artifact, fact append, and
re-inspection remain in the path. The test proves no manual worktree/branch
surgery, exact-once attempt/verification/review/close facts, and one receipt
per recovery action.

The six lifecycle scenarios pass locally on macOS through the trusted-local
native route. #1232 added the Ubuntu trusted-local production-seam job and PR
#1238 passed it. Both paths require zero forge or remote-transport effects.

## Crash and compatibility matrix

The closure matrix uses real spawned children plus `NODE_OPTIONS` preloads and
canonical retries; it adds no production fault hooks.

| Named scenario | Durable boundary | Invariant asserted by the retry |
| --- | --- | --- |
| `real no-origin journey` | uninterrupted route-to-close | the public route reaches one terminal Reviewed Result with no forge or transport |
| `post-attempt` | durable `attempt_finished` with stale dispatch ownership | canonical `recover --break-lock` preserves exactly one attempt and continues |
| `post-commit` | real `update-ref HEAD` succeeds before the recover parent is killed | the same recovery intent publishes one commit and one stable receipt |
| `post-verification` | `verification_recorded` appends before the recover parent exits | retry does not duplicate exact head/tree/Done Criteria/result evidence |
| `post-review` | production `runReview` appends `review_recorded` before its worker exits | retry is refused as ineligible and inspect exposes the durable review |
| `pre-close` | the child exits immediately before `run_closed` append | the same action key converges from zero terminal facts to one terminal fact and an immutable no-op receipt |

#1209 separately freezes the GitHub action-key/review-artifact corpus. The
serialized full gate retains that corpus unchanged; the local route does not
relax any GitHub behavior.

## Supported combinations and non-goals

| Source | Delivery | Result |
| --- | --- | --- |
| Git + identity-matching GitHub origin | GitHub PR | Existing exact-SHA review and explicit `ready_to_merge`/merge path. |
| Git + no remotes | None | Exact local commit, verification, independent review, terminal `reviewed_result_ready`. |
| Git + GitLab or another remote | None | Typed pre-effects refusal; #1210 needs a concrete consumer. |
| Non-Git directory | None | Typed pre-effects refusal; initialize Git explicitly or use `delegate`. |

Non-goals: automatic `git init`, plain-Git publication receipt (#1211), GitLab
without a consumer (#1210), non-Git isolation (#1212), treating push as
landing, mutable manifests/migration overlays, a second writer, and a generic
forge adapter framework.
