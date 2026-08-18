# ADR-0007: Freeze the Derived ReviewSubject Contract

Status: Accepted (issue #1209; parent #1204)

## Context

Relay already binds review and merge to immutable run, Git, verification, and
review evidence, but the binding lacked one named contract. Adding a stored
object or fact would create a second authority. The current GitHub lifecycle
must remain unchanged while terminology becomes forge-neutral.

## Decision

`ReviewSubject` is documentation shorthand for this exact derived value:

| Member | Existing authoritative derivation |
| --- | --- |
| object format | `sha1`: current run, fact, review, and GitHub OIDs are 20 bytes represented by exactly 40 hexadecimal characters, as enforced by the existing readers/gates. |
| base OID | Exact live GitHub `pr_base_sha`; local delivery instead uses immutable `run.json.git.start_sha`. This selects the route-specific review diff basis without adding a stored field. |
| reviewed head OID | Fresh GitHub `pr_head_sha`, which must equal the derived head and latest durable `pull_request_recorded.payload.head_sha`. |
| tree OID | Latest passed `verification_recorded.payload.tree_sha` for that head and frozen Done Criteria; it must equal the freshly observed Git tree while the local observed head equals the live PR head. |
| binary diff SHA-256 | SHA-256 of the immutable bytes made by `git diff --binary --no-ext-diff <live_pr_base>...<head> --` for GitHub delivery or `<start_sha>..<head>` for local delivery, with one trailing LF added only when non-empty output lacks it. |
| frozen Done Criteria SHA-256 | Immutable `run.json.contract.done_criteria_sha256`, rechecked against the regular file bytes before review and under the append lock. |

The Reviewed Result is terminal proof of exact verification and independent
review: the immutable review artifact and `review_recorded` fact must bind the
reviewer to `run.json.roles.reviewer` and bind the reviewed head and Done
Criteria digest to this subject. A Reviewed Result does not imply Publication
or Landing. Landing additionally requires the exact live Change Request
repository, base ref, head ref, PR number, and head SHA, plus the passed
verification and Reviewed Result. Reinspection under the run lock must produce
the same action key before any write.

## Current ownership boundaries

- Dispatch and executors edit the retained worktree and record attempt
  evidence; dispatch does not commit, push, create a Change Request, or run
  recovery.
- Canonical `recover` owns Publication: placing the exact revision on a remote
  ref. The retained GitHub route separately records or creates its forge-owned
  Change Request identity.
- `review-runner` derives the ReviewSubject from existing evidence and records
  the Reviewed Result after exact verification and independent review. It does
  not publish or land the revision.
- Explicit `relay-merge` owns Landing: it applies the reviewed revision to the
  target and independently observes the result.
- `run.json`, append-only `events.jsonl`, and fresh observations remain the
  runtime authorities; ReviewSubject adds no stored object or fact.

`ReviewSubject` introduces no runtime field, fact, helper hierarchy, adapter
seam, delivery registry, compatibility reader, or review loop. Git remains
required for content identity. A forge is optional to the architecture, while
the retained production route continues to use GitHub for remote Publication,
Change Request identity/review observation, and Landing without routing or
lifecycle changes.

## Consequences

- Source, ReviewSubject, Publication, Change Request, Reviewed Result, and
  Landing have one meaning across capability, architecture, and operator docs;
  Publication is not Change Request creation and does not imply Landing.
- Versionless records remain invalid historical input and earn no reader.
- The minimized current inventory's six schema-v3 nonterminal runs drain in
  place; no record is migrated or mutated, and future schema work is blocked
  until all six are terminal or an operator explicitly closes them.
- Narrow regression tests pin actions, reasons, action keys, exact identity
  matching, live-head binding, and same-action lock reinspection.

## Evidence

- Current derivation: `inspect.js`, `review-runner.js`, `run-store.js`, and the
  merge review gate, unchanged by #1209.
- Anonymous inventory and reproduction: [`run-inventory-1209.md`](../archive/historical/run-inventory-1209.md).
