Parent: #1129

## Outcome

Introduce the vNext immutable run record and append-only fact journal, with a pure lifecycle fold running in shadow mode beside the legacy manifest.

## Scope

- Add an immutable `run.json` identity record and a per-run append-only fact journal.
- Define closed, versioned payload schemas for lifecycle facts.
- Implement atomic fact append with one write, durability sync, and torn-tail quarantine.
- Implement a deterministic pure fold from `run + facts + live observations` to the next operator action.
- Emit shadow comparison results without changing production decisions.

## Acceptance criteria

- [ ] `run.json` identity and Done Criteria cannot be mutated after creation.
- [ ] Every fact type has a closed schema and unknown fields/types fail validation.
- [ ] Appends use exclusive ownership, append semantics, one encoded record per write, and durability sync before success.
- [ ] A partial final record is quarantined and reported; earlier valid facts remain readable.
- [ ] The fold implements the precedence table in the parent spec and is deterministic under replay.
- [ ] Shadow mode performs no vNext lifecycle writes other than comparison telemetry.
- [ ] Legacy/vNext shadow agreement: **withdrawn** with the migration on 2026-08-03. vNext is the only writer and no legacy reader remains to compare against.

## Verification

- Property tests for replay determinism, duplicate delivery, event ordering, and terminal-state monotonicity.
- Fault injection at open/write/sync/rename/read boundaries.
- Golden fixtures for every event schema and derived action.

## Implemented runtime boundaries

- A run directory is identity-bearing: its canonical basename, immutable
  `run.json.run_id`, every fact's `run_id`, and the sole
  `events.jsonl` journal must agree.
- `evaluateLegacyShadow()` was the migration-only shadow entry point. It was
  wired at the now-retired legacy observer, where live Git, GitHub PR,
  repository identity, and lease observations were available when
  `RELAY_VNEXT_SHADOW_TELEMETRY_DIR` was configured. It parsed the manifest and
  events from source bytes, rejects caller/source disagreement, folds them,
  and fsyncs comparison telemetry without changing the production decision.
- Review is invoked through an argv child process. The child receives only an
  immutable, digest-bound criteria/prompt/diff/request staging directory
  outside the run directory; executor session state and source paths are not
  accepted inputs. Its argv uses a closed literal-or-staged-file schema, its
  environment is allowlisted, and `cwd`, `HOME`, and `TMPDIR` are the staging
  directory. macOS sandboxing is used when available; hosted Node reviewers
  use Node's filesystem permission model only when the runtime advertises all
  required flags. Every reviewer fails closed with an isolation-unavailable
  error when neither mechanism is supported.
- Merge recording requires the unforgeable authorization capability returned
  by an explicit operator merge plan bound to an issued run lock, a fresh
  observer nonce, the current PR head, and the frozen Done Criteria digest.
  The durable authorization is HMAC-authenticated with a host-created
  owner-only key and binds run, operation, authorization, operator, nonce,
  method, PR, head, and criteria identities. Resume re-observes under a newly
  issued lock, and recording requires GitHub to report `MERGED`, the exact
  authorized PR head, and the observed result target SHA before converging an
  append-before-receipt crash without a duplicate merge fact.
- Immutable run, fact, request, and artifact reads open with `O_NOFOLLOW`,
  validate the opened descriptor before and after reading, and remain bound to
  that inode if the pathname is swapped concurrently.
- Recovery first persists an operation intent, uses the stable operation ID for
  a convergent apply, and freshly re-observes the external system before
  atomically publishing an fsynced receipt. A crash after the external effect
  therefore converges without applying the effect twice.
- Torn tails are copied to collision-safe quarantine artifacts and the
  directory is fsynced before the journal is truncated and synced.

## Rollback

Disable shadow evaluation and continue using the untouched legacy manifest path.

## Dependencies

- #1130
