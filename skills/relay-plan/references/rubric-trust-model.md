# Rubric — Trust-Model Audit Factor

Authoring guidance for rubrics on tasks that cross an **auth boundary**. Schema-only factors let the original vulnerability survive under a new shape; this reference forces you to name the runtime enforcement layer as its own factor.

## When to apply

Trigger this checklist during rubric design (relay-plan step 2) if any of the following is true:

- The issue carries the `phase-0-follow-up` label.
- The issue or its AC mentions any of: **trust root**, **anchor**, **invariant**, **grandfather**, **validate**, **forge/forgery**, **bypass**, **gate-check**, **auth(-boundary)**, or any `validateTransition*` / `validateManifest*` / `evaluateReviewGate` callsite.
- The rubric author flags the task as "touches an auth boundary" (e.g., manifest fields that feed filesystem / GitHub / state-transition operations).

If none of the above holds, use `rubric-security.md` alone. This reference sharpens, not replaces, that file.

## The three questions (each yes → one named factor)

Every auth-boundary rubric MUST answer all three questions *out loud*, in prose, before drafting factors. Each yes becomes one rubric factor — not an aspiration in a criteria bullet.

### 1. Who can forge a claim?

Assume an attacker has **write access to the run manifest or run dir** (the relay threat model: a malicious or confused executor, a compromised worktree, a hand-edited `~/.relay/runs/<slug>/<run-id>.md`). Can they mint a passing stamp purely by writing syntactically valid values into the manifest?

- If **yes**, the rubric needs an **authentication factor** — not just a schema factor. The factor must assert that forged manifests are rejected by the gate.
- If **no** (the claim requires a side effect the attacker cannot produce, e.g., a signed artifact, an external file write, a git commit), you may skip this factor; document *why* in the rubric's notes.

### 2. Where is the gate?

Name the **exact `file:function` call site** at which runtime enforcement happens. The factor must quote the line, not gesture at "the gate layer". Common sites in relay:

- `skills/relay-dispatch/scripts/manifest/rubric.js:getRubricAnchorStatus`
- `skills/relay-merge/scripts/review-gate.js:evaluateReviewGate`
- `skills/relay-merge/scripts/gate-check.js` (gate-time cross-checks)
- `skills/relay-dispatch/scripts/relay-resolver.js` (selector-level state enforcement)
- `skills/relay-dispatch/scripts/manifest/lifecycle.js:validateTransition*`

Manifest internals were split in #188 under `skills/relay-dispatch/scripts/manifest/*.js`; the top-level `relay-manifest.js` is now a 17-line compat facade that re-exports everything. Rubric factors should name the split submodule (`manifest/rubric.js`, `manifest/lifecycle.js`, etc.) — that path is stable across re-exports and matches what tests and runtime call sites actually import.

If the gate lives in prompt text (reviewer prompt, dispatch prompt) rather than a code-path transition, that is **not** a gate — it is at best a visible warning. See `feedback_rubric_fail_closed.md` meta-rule 1: "visible" and "fail-closed" are distinct layers; the rubric must name both.

### 3. What independently verifies the claim?

The gate must read an **external reference** — another file, a migration manifest, a signed artifact, a cross-check log — to verify the claim. Self-attestation (the claim's own bits in the same manifest) is not verification.

Examples of acceptable external verifiers:

- `~/.relay/migrations/rubric-mandatory.yaml` cross-checked against the stamped object (applied in #151/PR #207 round 4; retired at runtime in #190, but still useful as historical context when auditing the migration design).
- An event in `events.jsonl` that could only have been emitted by a code path the attacker cannot invoke.
- A filesystem property (file owner, immutable bit, `fs.realpath` under a trust-root directory) that the attacker cannot reproduce in their write zone.

If the answer is "the claim proves itself", the factor is incomplete.

## Worked examples

### Bad rubric (pre-#151 round 4)

Taken verbatim from the original rubric that shipped to PR #207 round 3 before codex surfaced the gap. This example is retained for its *shape* — a schema-only factor masquerading as an auth factor — even though the underlying `anchor.rubric_grandfathered` field was retired in #190 and dispatch now rejects it outright (see `skills/relay-dispatch/SKILL.md` and `dispatch.js:245`).

```yaml
- name: grandfather_object_schema
  tier: contract
  type: evaluated
  criteria: |
    - Dispatch accepts both boolean (legacy) and object (new) form
      of `anchor.rubric_grandfathered`.
    - Object form requires {from_migration, applied_at, actor}; malformed
      objects fail closed.
    - Tests cover legacy boolean, valid object, and malformed object.
  target: ">= 8/10"
```

**Why this failed at round 4**: the factor answered question 2 partially (mentions "fail closed" but does not name the gate site), did not answer question 1 at all ("malformed" ≠ "forged"; a plausible object is not malformed), and did not answer question 3 (no external verifier). A script-literate operator writes a plausible `{from_migration: "rubric-mandatory", applied_at: "2026-04-17", actor: "ops"}` and the run is grandfathered forever.

### Good rubric (#151 round 8, later retired by #190)

Replacement factors that landed after round 4 surfaced the gap. Note that question 1 and question 3 are each a **separate factor** — not a criterion bullet inside a broader factor. This remained the correct design for `#151`; `#190` later retired the runtime field entirely instead of continuing to authenticate it. The worked example still illustrates the *pattern* (schema + authentication + regression tests as three distinct factors) — just don't use `anchor.rubric_grandfathered` as a real factor target today; dispatch rejects the flag.

```yaml
- name: migration_manifest_present
  tier: contract
  type: automated
  command: "test -f ~/.relay/migrations/rubric-mandatory.yaml"
  target: "exit 0"
  # Question 3: external verifier exists before any runtime check can read it.

- name: gate_authenticates_object_form
  tier: contract
  type: evaluated
  criteria: |
    - `getRubricAnchorStatus` in `skills/relay-dispatch/scripts/manifest/rubric.js`
      reads `anchor.rubric_grandfathered` and, when object-shaped, calls
      `loadMigrationManifest()` and requires `from_migration` to match a
      registered entry. (Callers may also import via the `relay-manifest.js`
      compat facade; the split submodule is the canonical source.)
    - Hand-edited objects that reference an unregistered migration id fail closed
      with `reason: "migration_not_registered"`.
    - `evaluateReviewGate` in `skills/relay-merge/scripts/review-gate.js` reads
      the same authenticated status; a stamped-but-unregistered manifest does NOT
      reach `{status: "lgtm", readyToMerge: true}`.
  target: ">= 8/10"
  # Question 1: attacker with manifest write access cannot mint a passing stamp
  # without also writing to ~/.relay/migrations/ (outside the run dir).
  # Question 2: names both gate sites (dispatch + merge) by file:function.

- name: unregistered_migration_regression_tests
  tier: contract
  type: automated
  command: "node --test skills/relay-dispatch/scripts/relay-manifest.test.js --grep 'unregistered migration'"
  target: "exit 0"
  # Regression surface for question 1: the tests encode the threat model,
  # so future refactors cannot silently re-open the bypass.
```

The authentication factor is **distinct** from the schema factor (which may still exist under the name "accepts object form"). The two factors together close the loop: schema is necessary but not sufficient; authentication is what keeps the vulnerability from surviving under the new shape.

## Checklist — put this in the PR body

For any rubric that triggered this reference, the PR body must include:

```markdown
### Trust-model audit

- **Q1 (forge)**: [yes / no + why] — factor: `<factor-name>`
- **Q2 (gate)**: [`file:function`] — factor: `<factor-name>`
- **Q3 (external verifier)**: [file / artifact / property] — factor: `<factor-name>`
```

A PR that answered this reference's trigger but left any of the three questions blank in the PR body is rejected at rubric design (Grade D), same weight as a tier-minimum violation.

## Related

- `references/rubric-security.md` — broad security rubric guidance. Use alongside this reference; do not collapse.
- `memory/feedback_rubric_enforcement_layer.md` — source meta-rule for questions 1-3.
- `memory/feedback_rubric_fail_closed.md` — deeper meta-rule ladder (visible vs fail-closed vs recoverable vs authenticated).
