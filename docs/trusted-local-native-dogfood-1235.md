# Trusted-local native Relay dogfood (#1235)

This is bounded closure evidence, not a permanent provider admission matrix.
It records at least one real invocation per retained adapter, with bounded
retries only when the first result exposed an actionable selection, argv, or
task-precision problem. Provider
availability and account quotas may change without changing Relay support.

Every run used a fresh no-origin Git repository, ambient local CLI state, a
single-file bounded task, repository-local Relay scripts, and canonical
inspect/recover/review commands. The report retains run IDs, operator-attested
fact summaries, and source-artifact SHA-256 commitments captured before
temporary fixture cleanup—not prompts, provider output, environment values,
credential paths, or temporary filesystem paths. These commitments do not make
the deleted fixture bytes independently reproducible; deterministic repository
tests remain the authority for trust claims.

## Real invocation results

| Adapter | Dispatch and native isolation | Independent review / terminal result |
| --- | --- | --- |
| Codex 0.147.0 | Completed; `workspace-write` requested, native isolation effective. | Codex review LGTM with native `read-only`; canonical local close reached `reviewed_result_ready`. Run `dogfood-codex-20260812182515346-9dc33d91`. |
| Claude 2.1.228 | Created the exact file; `enabled` requested and native Bash isolation effective. The attempt retained a typed process-audit failure after its matched descendant was reaped, and canonical recovery preserved the work. | Claude review LGTM with read-only `not_requested`; canonical local close reached `reviewed_result_ready`. Run `dogfood-claude-20260812182821685-bfa6b3e6`. |
| Pi 0.84.1 | Completed; filesystem isolation unavailable/effective none, reported nonblockingly. | Pi review LGTM; canonical local close reached `reviewed_result_ready`. Run `dogfood-pi-1235-20260812182453715-7d336722`. |
| OpenCode 1.18.16 | The first route exposed a quota error and the missing noninteractive/diagnostic argv. After the argv correction, Nous Portal DeepSeek V4 Flash completed in about 19 seconds; isolation unavailable/effective none. | OpenCode review LGTM in about 53 seconds; canonical local close reached `reviewed_result_ready`. Run `dogfood-opencode-deepseek-1235-20260812185135719-0439da79`. |
| Antigravity 1.1.12 | The first model call edited the repository but exposed an exit-zero/empty-output adapter mismatch. After switching the adapter to its native JSON success envelope, a fresh semantic one-file task passed canonical commit and verification under declaration-only isolation. | The correctly bound native-schema review executed successfully and returned the provider's structured `escalated` verdict. Relay recorded `none/review_escalated` and did not fabricate a close. Run `dogfood-antigravity-bound-20260812192614011-1378317b`. |
| Cursor agent 2026.08.11-e8db854 | Native isolation was effective. Both automatic selection and one listed explicit model returned the provider-owned current-plan model-unavailable result before work. | No review was eligible; cleanup completed and the run remains an honest redispatch result. Run `dogfood-cursor-20260812182409782-d70626ed`. |
| Cline 3.0.49 | Filesystem isolation unavailable/effective none. The configured provider returned a structured error before work. | Primary review was rejected before invocation with the documented typed unsupported-contract error and zero review facts. Run `dogfood-cline-20260812182800130-a4b52570`. |

Five rows have captured operator-attested summaries below. Cursor and Cline are
bounded observations whose temporary fixtures were removed before
run/events hash capture; neither category replaces deterministic trust-boundary
evidence.

| Run | `run.json` SHA-256 | `events.jsonl` SHA-256 | Operator-attested summary |
| --- | --- | --- | --- |
| Codex `...9dc33d91` | `97b3ba77da47d942242552df15a49ee09fa07702dcc6ba3d5ee2370302c0e97b` | `fe46ca66648a8831caf4e3f07d58e9853647faea56933d2cd8deb7f1fa9ddcf8` | 18 facts; attempt 1/1, verification 1, review LGTM 1, close 1; `reviewed_result_ready` at `d39d9eee0920d8d0c8b1fc9e9232acb6f11ac4f6`. |
| Claude `...bfa6b3e6` | `ae780ec0b583f4100a9f2a59caa320c9a0e7ad5d705412e37f97d459ea363317` | `96bee5ecc91558e6db98e1d0501700281d2358065352e1b832ac2f1cc2d03405` | 18 facts; attempt 1/1, verification 1, review LGTM 1, close 1; `reviewed_result_ready` at `1aa8213cfad079886b60631584c881cbfe4ee50f`. |
| Pi `...7d336722` | `c7b5e2e4b6d71b82576aac9ce1f59a26064601b58dd54ef2ffe5360087440c88` | `ad98367d3f1c93269f3daed472c104b85eba2df40324867724bd973fd9244c6d` | 18 facts; attempt 1/1, verification 1, review LGTM 1, close 1; `reviewed_result_ready` at `cfeec42f445323f6f6b2daaa8f8200c738f0532b`. |
| OpenCode `...0439da79` | `d614f6b9f6a46cc6ce9aea15c5f7019a08efb6285dc679df4dd1360f09d69403` | `41d4003f74362e46cafbce576a743426229367b0c34cbba8f95a2d0e72281fec` | 18 facts; attempt 1/1, verification 1, review LGTM 1, close 1; `reviewed_result_ready` at `c89e1cb41db63c52991d4398ebb39d1d4be05674`. |
| Antigravity `...1378317b` | `f0811f9b665a70d3284338ae10a407a93358ec76742205bc2f1d2881534e00e0` | `7d476e2f316f89ad115bb4d9b710ee4af52a5f922d98cf7c3b3d8a0ac7d33dcd` | 13 facts; dispatch/commit/verification passed; native-schema review at `fc7359349a043718e99560e21792c27a46963f52` returned typed reviewer escalation; close 0, live host 0. |

The four priority development paths—Codex, Claude, Pi, and OpenCode—therefore
completed real dispatch, canonical commit and verification, independent review,
and terminal local closure. Missing native filesystem isolation did not block Pi
or OpenCode. No run required copied credentials, private HOME/XDG roots, manual
Git edits, or lifecycle-artifact surgery.

## Delivery-route evidence

The real #1235 calls deliberately used the no-origin route. Normal GitHub
delivery was not re-executed for every provider: it is a route property, not an
adapter matrix. The retained canonical GitHub execution
`issue-1205-20260811224423726-5b0c3bbc` created and explicitly merged
[PR #1226](https://github.com/sungjunlee/dev-relay/pull/1226) after exact-SHA
review; GitHub records head `3c12337ee42872585f50cea179009186e7a7c27e`,
merge commit `14b2ddb0284fb87932a5eb96122ab8743c039c60`, and all nine repository test
jobs plus CodeRabbit passing. Its captured source hashes are run
`f25f71a4a99187f063e1f4d9250a4032b8812929cf757133b15e72e586174b63`
and events
`fdbf84d061ce2d37d38fe27f5e537dc4c2063db74ddf05f678e83e6e2d3f2bff`;
the 20-fact journal contains one PR fact, one verification, two reviews (latest
LGTM at `3c12337ee42872585f50cea179009186e7a7c27e`), and one merge fact. #1235's
serialized gate rechecks the same exact-SHA/explicit-merge route contracts while
the fresh calls above exercise ambient auth and native-isolation behavior.

## Dogfood corrections

The exercise found three Relay-owned usability gaps; the bounded #1235 change
corrects the first two and the OpenCode invocation contract:

- Same-run redispatch now resolves the immutable executor from `run.json` when
  `--executor` is omitted and rejects an explicit mismatch before prompt or fact
  writes. Models remain per-attempt.
- Relay base paths canonicalize an existing platform alias such as macOS
  `/tmp` before any branch, worktree, or run record is created. Relay-owned
  symlink and non-directory boundaries still fail closed.
- OpenCode dispatch and review use its current noninteractive diagnostic argv:
  `--auto --print-logs --log-level ERROR --pure`. A quota-blocked route was not
  counted as success; the corrected argv was proven with a different configured
  route through terminal closure.

Antigravity's empty-success protocol is corrected in this change; the final
fresh semantic task passed verification and its provider-owned structured
review escalation remained blocking. Cursor plan
eligibility and the Cline provider failure are provider/account observations,
not reasons to add a credential or sandbox gate.

## Retained safety evidence

Real provider calls are convenience evidence. Durable trust claims continue to
come from deterministic tests: immutable staged input mutation produces zero
review facts; timeout/cancel reaps the exact process scope; crash retries
converge through the canonical writer; verification and review remain bound to
exact Git SHAs and frozen Done Criteria; GitHub merge remains explicit; and the
no-origin route closes only after passing verification and independent review.
The final serialized gate and pull-request checks are recorded in the sprint and
GitHub issue after this change is fixed and merged.
