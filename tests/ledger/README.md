# Relay vNext test deletion ledger

`vnext-test-ledger.json` gives every relay test file a default decision plus
explicit site rules for mixed-purpose files. `vnext-test-sites.generated.json`
records the fully resolved owner, classification, rationale, and
classification-specific fields for every lexically registered `test`, `it`,
`describe`, and `t.test` site. Preserved sites may reference only canonical
`RR-01` through `RR-12` invariants.

The stable identity contract is:

```
relative path + registration kind + lexical ordinal
```

The generated row also records the literal name (or dynamic expression), source
line, and disposition. A loop or template can create a variable number of
runtime cases, so the exact accounting unit is its single static registration
site. This avoids pretending runtime cardinality is stable while still making
source additions, removals, renames, and directive changes reviewable.

Generate deterministic artifacts:

```bash
node tests/skills-lint/scripts/vnext-test-ledger.js generate
```

Check for missing, duplicate, stale, or malformed entries:

```bash
node tests/skills-lint/scripts/vnext-test-ledger.js check
```

Print the reproducible baseline and checked-in measurements without running
benchmarks:

```bash
node tests/skills-lint/scripts/vnext-test-ledger.js baseline
```

Refresh the focused E2E flake baseline. The checker requires ten repetitions of
each black-box scenario (twenty command runs total):

```bash
node tests/skills-lint/scripts/vnext-test-ledger.js measure --samples=10
node tests/skills-lint/scripts/vnext-test-ledger.js generate
```

The measured commands are the real `RR-01 worktree containment` dispatch E2E
test and the `RR-10 crash-safe idempotent recovery publication` E2E test from
`runtime-contract-blackbox.test.js`. Each sample has a 120-second timeout. The
artifact records per-scenario failures and the overall observed failure rate;
it does not claim to be a full-suite flake rate.
