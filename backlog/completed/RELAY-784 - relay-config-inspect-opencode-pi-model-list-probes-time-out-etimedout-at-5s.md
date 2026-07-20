---
id: RELAY-784
title: 'relay-config inspect: opencode/pi model-list probes time out (ETIMEDOUT at 5s)'
status: Done
labels:
  - bug
  - opencode
  - pi
priority: medium
milestone: Route Config Simplification
created_date: '2026-07-05'
---
## Description
## Observed

`relay-config inspect --json` on a machine with opencode and pi installed:

```text
optional model-list probe failed for opencode (opencode models) after 5000ms: spawnSync /Users/sjlee/.opencode/bin/opencode ETIMEDOUT
optional model-list probe failed for pi (pi --list-models) after 5000ms: spawnSync .../bin/pi ETIMEDOUT
```

Both CLIs work when invoked directly; the 5s probe budget appears too small for their cold start (both are node/bun CLIs with nontrivial startup).

## Expected

Model-list probes succeed on installed CLIs, or degrade with a clearly actionable warning.

## Notes

- Probe is advisory (`status: "warning"`), so severity is low — but Phase C's `gaps` mode will surface every failure as `probe_failure`, so a chronically timing-out probe becomes recurring noise.
- Root-cause first (cold start vs hang vs flag drift), then widen the timeout only at this blocking CLI boundary per the deflake policy (timing is not under test here). Consider making the budget configurable like the hardened event-binding wait (#764 precedent).
- Verify the probe commands against current CLI `--help` before touching timeouts (`opencode models`, `pi --list-models` may have changed shape).

## Acceptance Criteria

- [x] Root cause identified and stated in the PR (measured cold-start time or corrected invocation).
- [x] On this machine's setup, inspect reports model lists (or a non-timeout, actionable warning) for opencode and pi.
- [x] Probe budget change, if any, is configurable with a documented default.

Completion evidence: PR #791 merged and GitHub issue #784 closed on 2026-07-05.
