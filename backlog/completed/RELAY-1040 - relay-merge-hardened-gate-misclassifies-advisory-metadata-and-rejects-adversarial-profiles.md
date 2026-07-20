---
id: RELAY-1040
title: 'relay-merge: hardened gate misclassifies advisory metadata and rejects adversarial profiles'
status: Done
labels:
  - bug
  - workflow
priority: high
milestone: 2026-07 Assurance and Calibration Integrity
created_date: '2026-07-19'
---
## Description
## Problem

The hardened merge gate discovers advisory artifacts by filename:

```text
review-round-<round>-advisory-*.json
```

That pattern also matches advisory orchestration metadata such as
`*-request.json`, `*-result.json`, and `*-decision.json`. The gate then parses
every match as an advisory review with the profile hard-coded to `blindspot`.

This was reproduced from issue #981 / PR #1014. Its latest successful gating
lane produced a valid `profile: adversarial` artifact bound to a successful
`advisory_review` event, reviewed HEAD, artifact path, and SHA-256 hash. The
current gate rejects the metadata file first; if metadata files are excluded,
it still rejects the real artifact because the profile is not `blindspot`.

Risk-adaptive assurance now derives `hardened` for high-risk work, so this
blocks a first-class assurance path rather than an experimental route.

## Direction

Treat the durable successful advisory event as the provenance root. Do not
infer trusted artifacts from a broad filename glob.

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] For the latest reviewed round and HEAD, hardened merge validation selects advisory artifacts from matching durable `advisory_review` success events rather than `review-round-*-advisory-*.json` filename discovery.
- [x] `request`, `result`, `decision`, and other orchestration metadata JSON files are ignored unless they are explicitly bound as the successful advisory artifact.
- [x] The artifact payload profile must equal the event profile; valid `blindspot` and `adversarial` profiles are accepted without a hard-coded profile override.
- [x] The artifact must be a non-symlink regular file contained in the run directory and must match the event's path, round, reviewed HEAD, SHA-256 hash, success status, and zero required findings.
- [x] Multiple expected gating lanes remain fail-closed: one successful lane cannot mask a missing, failed, stale, or unbound required lane.
- [x] Regression coverage reproduces the #981 artifact set with `*-request.json`, `*-result.json`, `*-decision.json`, and a valid adversarial artifact, and proves the corrected gate passes it.
- [x] Existing forged, tampered, stale-HEAD, symlink, required-finding, and missing-provenance cases remain blocked.
<!-- AC:END -->

## Verification

- Focused `review-gate` unit suite.
- Relay-merge suite.
- A fixture shaped like the preserved #981 run demonstrates profile + hash +
  reviewed HEAD + durable success-event binding.

## Related

- #981 / PR #1014: live reproduction source.
- #532: original hardened merge-gate enforcement.
- #1031 / PR #1034: risk-adaptive assurance makes hardened the derived floor
  for high-risk work.
