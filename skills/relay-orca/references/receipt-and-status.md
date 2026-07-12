# Reconstructible receipt + read-only `status`

`run` persists a minimal, versioned **bridge receipt**; `status` is a strictly read-only
reconciler that derives a normalized program view from that receipt plus live relay
manifests, GitHub, and Orca runtime signals. Neither introduces a second program state
machine. This reference is the reviewer anchor for #945.

> This receipt is reconstructible coordination metadata, not a source of truth.

That exact sentence is carried verbatim in every receipt's top-level `note` field.

## Receipt path and slug derivation

```
~/.relay/programs/<repo-slug>/<program-segment>/receipt.json
```

`<repo-slug>` is derived **identically** to relay's run-dir slug (see
`skills/relay-dispatch/scripts/manifest/paths.js` `getRepoSlug`): the lowercased,
dash-sanitized basename of the **canonicalized repo root** joined to the first 8 hex chars
of its `sha256`. relay-orca replicates the algorithm in `scripts/lib/repo-slug.js` — it does
**not** import cross-skill code. The canonical root is resolved the same way relay does (git
common dir → `realpath` of its parent), so a receipt lands under the same slug relay uses for
its run manifests. The programs root is overridable for tests via `RELAY_ORCA_PROGRAMS_ROOT`
(validated absolute path; invalid → ignored, default used).

### Program-segment encoding + identity check (collision-resistant)

`<program-segment>` is **not** the raw program id. A pure sanitize is lossy — `"a b"` and
`"a+b"` both collapse to `"a-b"`, which would silently point two distinct programs at ONE
receipt. So the segment is the sanitized base (`[^A-Za-z0-9._-]+` → `-`, trimmed of leading/
trailing dashes; empty / `.` / `..` collapse to `program`; then **truncated to at most 64
chars**, re-trimming any trailing dash the cut exposes) joined to the first 8 hex chars of
`sha256(<raw program id>)`:

```
<sanitized-base (≤ 64 chars)>-<sha256(raw id)[0:8]>
```

The hash disambiguates ids that sanitize identically **or that share a 64-char prefix** — it
is computed over the **full raw id**, never the truncated prefix — while the readable prefix
keeps the path scannable, and it also keeps `.`/`..` (and any other traversal attempt) on
**distinct**, non-escaping segments. Bounding the readable prefix (A15) keeps a pathologically
long program id from overflowing the filesystem per-segment name limit (NAME_MAX, typically
255) so the receipt still writes and loads; the appended hash guarantees two long ids sharing
the same 64-char prefix stay on distinct paths. `run.js` and `status.js` apply `programSegment`
identically, so a `run`-written receipt resolves back for `status`.

On load, `status` also enforces an **identity check**: the receipt's `program_id` MUST equal
the requested `--program-id`. A mismatch (hand-edit, misplaced write, or a sanitized-segment
collision the hash is meant to prevent) fails closed as `RECEIPT_CORRUPT` (exit 51) with a
bounded message naming **both** ids — never a silent reconcile of the wrong program.

## Receipt schema (v0)

Top-level keys, verbatim: `schema` (literal `1`), `program_id`, `source` (program file path),
`repo` (`{ slug, root }`), `runtime_id`, `tasks`, `terminals_created`, `created_at`,
`updated_at` (ISO-8601), `note` (the authority-disclaimer sentence above). Each `tasks[]`
entry: `outcome_id`, `task_id`, `kind`, `wave`, `orca_task_id`, `dispatch_id`, `assignee`,
`relay_ids` (`{ request, run, fleet }`, each `null` or a string).

The receipt records **only identity and mapping**. It MUST NOT contain child lifecycle
states, PR/issue status, Done Criteria text, completion flags, prompts, or terminal output.

- **Atomic write:** a temp file in the same directory + `rename`. Partial/torn receipts are
  impossible by construction.
- **Write points (bounded edit to `run`):** after **each** successful task-create (A12),
  immediately after **each auto-created operator terminal** is recorded (A16), and immediately
  after each dispatch-show provenance verification — **before** the operator prompt is
  delivered (mapping-changing steps only). Persisting after every task-create means a
  `TASK_MATERIALIZE_FAILED` (exit 41) raised mid-wave still leaves every earlier outcome's
  `orca_task_id` durably on disk — the partial mapping is never lost — before the failure
  propagates. Persisting immediately after an auto-created terminal (A16) means a dispatch (or
  provenance) failure right after terminal creation leaves the receipt already carrying the
  handle in `terminals_created`, so a reconcile can **adopt** (not re-create) that terminal
  instead of leaking it — the receipt is written **before** the dispatch that may fail, not
  only after dispatch-show. Likewise a prompt-delivery failure leaves the receipt already
  carrying the verified `(orca_task_id, dispatch_id, assignee)` trio, so a later reconcile
  recovers the created tasks / dispatch instead of re-materializing them. (There is no separate
  post-materialization write — the last per-create write already covers it.) `run`'s report
  grows by exactly one key, `receipt_path`.

## `status` authority order (durable truth outranks runtime signals)

1. **Relay manifests** — child run manifests are read from `<runs-root>/<repo-slug>/`; fleet
   manifests are read from a **separate** `<fleets-root>/<repo-slug>/` (see
   [Fleets-root resolution](#fleets-root-resolution)). The manifest `state` is the relay
   lifecycle truth. `<runs-root>` follows relay's own resolution precedence (first hit wins,
   each candidate must be an **absolute** path; a non-absolute value falls through to the
   next):
   1. `RELAY_ORCA_RUNS_ROOT` (relay-orca-specific override; tests use this)
   2. `RELAY_RUNS_BASE` (relay's runs-base override)
   3. `RELAY_HOME` + `/runs` (relay's home override)
   4. `~/.relay/runs` (default)
2. **GitHub** — `gh issue view <n> --json state,stateReason` and read-only `gh pr view`
   queries, via an injectable gh binary (`--gh-bin` / env). The PR evidence is fetched with
   **two required** `gh pr view` sub-reads whose `--json` field lists are literals registered
   in the repo-wide pr-view field-list contract: a merge read (`mergedAt,state`) and a head
   read (`number,headRefName,headRefOid`). Both are required (A20) — see
   [Failed required reads](#failed-required-orca-reads--unreachable-never-fabricated-empty-state).
3. **Orca (runtime signals only)** — `status --json`, `orchestration task-list --json`,
   `gate-list --json`, `dispatch-show --task <id> --json`, all read-only, all through the
   probe's binary-resolution rules.

Orca task status and `worker_done` are lifecycle signals, **never** completion authority. An
outcome is `complete_with_evidence` ONLY when its live durable evidence holds — per the task
kind's expected-evidence defaults in [task-kinds.md](task-kinds.md), enumerated below.

### Per-task-kind evidence contracts

Each task kind names its **own** live evidence checks (`status-classify.js`). An outcome is
`complete_with_evidence` only when EVERY named check for its kind holds `true`; a `null` check
is "unknown" (source not yet resolvable — e.g. Orca untrusted) and never completes. The report
surfaces these checks verbatim in each outcome's `evidence` object, so no kind is
unclassifiable.

| task_kind | evidence keys (all must be `true`) | source |
| --- | --- | --- |
| `relay_run` | `manifest_terminal` (manifest `merged` **only**, A14), `pr_merged`, `issue_closed` | mapped relay run manifest + PR/issue |
| `relay_fleet` | `fleet_children_terminal` (child terminal set = `{merged, closed, escalated}`, A18), `fleet_manifest_closed` | fleet manifest via `relay_ids.fleet` + each child run manifest |
| `integration_gate` | `gate_report_present`, `gate_check_passes` | live Orca gate (`kind` `"integration"` or untyped) mapped to the outcome's `orca_task_id` |
| `advisory_review` | `advisory_evidence_posted`, `blocking_findings_triaged` | live Orca gate **explicitly** `kind: "advisory"` (A19) mapped to the outcome's `orca_task_id` |
| `tracker_reconciliation` | `tracker_reconciled` | mapped relay run manifest terminal AND its tracker issue closed |

- **`relay_fleet`** resolves the fleet manifest via `relay_ids.fleet`. Fleet manifests live
  under a **separate fleets root** — `<fleets-root>/<repo-slug>/<fleet-id>.md` — NOT the runs
  root that holds child run manifests (this mirrors relay-fleet's own layout; see
  [Fleets-root resolution](#fleets-root-resolution) below). The fleet manifest carries a
  single-line JSON `children` array — `[{"leaf_ref":"…","run_id":"…","dispatch_status":"…"}]`
  (the real relay-fleet shape) — and `fleet_state`. `fleet_manifest_closed` is
  `fleet_state ∈ {merged, closed}`; `fleet_children_terminal` requires ≥1 child and every
  child `run_id` to resolve to a **terminal** run manifest **under the runs root** (children
  are ordinary relay runs; only the fleet manifest itself lives under the fleets root).
  A child is **terminal** when its state ∈ `{merged, closed, escalated}` (A18) — an escalated
  child is terminal (it will not progress on its own) but NOT *complete*. Fleet **completion**
  still requires every child at `merged`/`closed`, so an escalated child in a closed fleet
  makes `fleet_children_terminal` `true` (the fleet reached a terminal configuration) yet the
  outcome is `escalated`, never `complete_with_evidence` (terminal ≠ complete — see the State
  taxonomy pinned decision below).
- **Read-only gate kinds** (`integration_gate`, `advisory_review`) are receipt-referenced
  through the outcome's `orca_task_id`: the evidence source is the live decision/review gate
  mapped to that task. A gate "passes"/"triaged" when its live status ∈ `{passed, approved,
  resolved}`; a pending gate leaves the outcome `awaiting_decision`. When the runtime is
  untrusted (mismatch / foreign / unreachable), both checks degrade to `null`. The modeled
  gate shape is `{ id, task_id, status, kind }`; a gate is matched to an outcome when its
  `task_id`/`task` equals the outcome's `orca_task_id` (or it lists that id in `blocks`).
  **Gate-kind markers:** `integration_gate` evidence is satisfied by a gate whose `kind` is
  `"integration"` **or is absent/untyped** (an untyped gate defaults to integration).
  `advisory_review` evidence (A19) requires a gate **explicitly** marked advisory — its `kind`
  is exactly `"advisory"`. There is **no** "first gate" fallback: a non-advisory or untyped
  gate mapped to an `advisory_review` task is **never** advisory evidence, so a passed
  integration/untyped gate can never forge advisory completion; none present →
  `advisory_evidence_posted` `false` → not complete.
- **`relay_run`** completion is **`merged`-only** (A14): `manifest_terminal` holds `true` only
  when the mapped run manifest reached `merged` — **not** merely any terminal state. A
  terminal-but-`closed` (force-closed / abandoned) manifest can never yield completion
  evidence again, so `manifest_terminal` stays `false` and the outcome surfaces as
  `escalated` — never `complete_with_evidence` — even if the PR shows merged and the issue
  shows closed. (`relay_fleet` and `tracker_reconciliation` keep their existing terminal-state
  contracts.)
- **`tracker_reconciliation`** reconciles the mapped relay run's tracker issue against its
  durable manifest: reconciled = terminal manifest **and** the live issue `CLOSED`.

### Fleets-root resolution

Production relay-fleet manifests do **not** live beside child run manifests. relay-fleet
writes them to `<fleets-root>/<repo-slug>/<fleet-id>.md`, a directory **separate** from the
runs root (confirmed in relay-dispatch's `manifest/paths.js`: `getFleetsBase()` returns
`RELAY_HOME + "/fleets"`, default `~/.relay/fleets`). `status` therefore resolves the two
roots independently: a `relay_fleet` outcome's `relay_ids.fleet` loads the fleet manifest
from the **fleets root**, while its children (ordinary relay runs) continue to load from the
**runs root**. `<fleets-root>` uses the same first-hit-wins, absolute-validated fall-through
as `<runs-root>`, adapted to relay-fleet's convention:

1. `RELAY_ORCA_FLEETS_ROOT` (relay-orca-specific override; tests use this)
2. `RELAY_FLEETS_BASE` (the `RELAY_RUNS_BASE` parallel; honored if it is ever set)
3. `RELAY_HOME` + `/fleets` (relay-fleet's actual convention)
4. `~/.relay/fleets` (default)

A fleet manifest that is *not* present under the fleets root leaves the outcome's fleet
evidence `null` (unknown) — it is never silently resolved from the runs root.

### Failed required Orca reads = unreachable (never fabricated empty state)

The runtime is `ok` (Orca facts adopted) **only** when `status` AND `task-list` AND `gate-list`
all succeed and attribute to this program. A failed **required** read (task-list or gate-list)
degrades the runtime to `unreachable`: Orca-derived facts are **withheld** (outcomes degrade
per D5 — `stale_missing` while durable evidence still renders), and NO diagnostics are
fabricated. A `status` read that **succeeds** but carries **no usable live runtime id**
(missing, empty, or non-string) is equally unattributable (A13) — the live runtime cannot be
proven to be the one the receipt mapped — so it too degrades to `unreachable`, withholding
Orca facts rather than silently trusting an unidentified runtime (this is the same withholding
as A4, not a fabricated `RUNTIME_MISMATCH`). A failed task-list must never forge a `MISSING_TASK` against a receipt whose task
simply could not be listed, and a failed gate-list must never be treated as "no pending gate"
(which would silently suppress `awaiting_decision`). A per-task `dispatch-show` failure marks
only that task's Orca facts **unknown** — never `MISSING_TASK` / `MISSING_DISPATCH`.

**Per-read runtime-id attribution (A17).** Adopting a read is not just about it succeeding —
it must be proven to come from the runtime the receipt mapped. The `status` read establishes
the reference runtime id (A13 guarantees it is a non-empty string). **Every** adopted read
then carries `_meta.runtimeId` and is validated against that reference before its data is
used:

- **Whole-runtime reads** (`task-list`, `gate-list`): a mismatched or missing-where-expected
  `_meta.runtimeId` degrades the runtime to `unreachable` — Orca facts are **withheld**
  exactly like a failed required read (A4), never adopted from an unverifiable runtime, and no
  diagnostic is fabricated.
- **Per-task `dispatch-show`**: a reachable read whose `_meta.runtimeId` is mismatched or
  missing-where-expected makes **only that task's** runtime facts **unknown** — its dispatch
  facts are withheld (so no false `MISSING_DISPATCH` / `MISSING_TERMINAL` is forged) and that
  outcome degrades to `stale_missing`, leaving every other outcome unaffected. (A transiently
  failed/unreachable `dispatch-show` has no id to check and keeps its existing pass-through
  handling — it never forges a diagnostic.)

The same honesty applies to **GitHub**: a failed **required** live GitHub read for an
outcome's evidence contract (`gh pr view` feeding `pr_merged`, `gh issue view` feeding
`issue_closed` / `tracker_reconciled`) leaves that fact `null` and degrades the outcome to
`stale_missing` rather than reporting a false-clean `running`. The command still exits `0`
(durable-complete evidence, if any, still wins), and the read never fabricates a fact it
could not fetch.

The PR read is fetched via **two required sub-reads** (merge state + head), and **both are
required** (A20): if EITHER the merge read or the head read fails or returns invalid JSON,
the whole PR source is `unreachable` (`ok:false`) → the outcome degrades to `stale_missing`.
The head read is **never** substituted with `{}` while keeping the PR source `ok:true`,
because a resulting `null` `headRefOid` silently disables the `PR_CHANGED` head-moved detector
and could complete a `merged` outcome whose head actually moved. A merged manifest with a
closed issue therefore never false-completes when the live head could not be fetched — it
degrades to `stale_missing` (A11/A20).

## Foreign / ambiguous runtime is never adopted

If the live Orca `_meta.runtimeId` differs from the receipt's `runtime_id`, or the runtime
carries orchestration tasks whose titles lack this program's `relay-orca:<program_id>/`
marker, Orca-derived facts are **not** adopted (they degrade to `stale_missing`); the report
sets `runtime` to `"mismatch"` or `"foreign_state"` and durable truth still renders. Foreign
tasks are never listed as this program's tasks.

## State taxonomy

Outcome `state` is exactly one of: `running`, `awaiting_decision`, `complete_with_evidence`,
`escalated`, `stale_missing`, `inconsistent`.

Program `state` is one of those six or `ready_for_next_wave` (every outcome in the preceding
waves of the lowest incomplete wave is `complete_with_evidence`, no outcome is
`escalated`/`inconsistent`, and the next wave is not yet started). Pinned decisions:

- Orca task completed/`worker_done` BUT (open PR OR non-terminal relay manifest) →
  `inconsistent` (stale-`worker_done` rule; never complete).
- Live durable evidence complete BUT Orca terminal/task gone → `complete_with_evidence`
  (durable truth wins; the vanished runtime signal is a diagnostic only).
- Mapping present but the referenced Orca task/dispatch/terminal is missing AND durable
  evidence is not terminal → `stale_missing`.
- A `relay_run` whose manifest is terminal-but-`closed` (force-closed / abandoned) →
  `escalated`, never `complete_with_evidence`, regardless of a merged PR or closed issue
  (relay_run completion is manifest `merged` only, A14).
- A `relay_fleet` with an **escalated** child (child terminal set = `{merged, closed,
  escalated}`, A18) → `escalated`, never `complete_with_evidence`, even in a closed fleet
  where every child is terminal — terminal ≠ complete, and completion requires every child
  `merged`/`closed`. The all-`merged` fleet still completes.
- A pending decision gate blocking the outcome's task → `awaiting_decision`.

## Detector matrix (verbatim diagnostic codes)

Each diagnostic is `{ code, outcome_id | null, message, ids }` with `code` one of:

| code | condition |
| --- | --- |
| `RUNTIME_MISMATCH` | live runtime id differs from the receipt, or the runtime carries unmarked foreign tasks |
| `MISSING_TERMINAL` | a mapped operator terminal is gone |
| `MISSING_TASK` | a mapped Orca task is absent from the live task-list |
| `MISSING_DISPATCH` | a mapped dispatch is no longer reported |
| `DUPLICATE_MAPPING` | two receipt entries share an `orca_task_id` or a relay run id |
| `MISSING_RELAY_RUN` | a mapped relay run has no manifest |
| `PR_CHANGED` | the PR head moved or its state regressed relative to durable evidence |
| `ISSUE_REOPENED` | the issue is open though the outcome's evidence contract requires closure |
| `STALE_WORKER_DONE` | an Orca task reports done but durable evidence is incomplete |

Diagnostics carry stable IDs (task/dispatch/run/PR numbers) and remediation hints but NEVER
terminal output, secrets, or env values. **Every** subprocess-derived value that reaches a
diagnostic is bounded to ≤ 256 chars (marker included), the same rule the probe uses — and
this holds for values inside the `ids` object, not only inside `message`. `ids` values are
restricted to normalized stable identifiers; each is passed through the shared bounded-excerpt
helper (`boundedIds` in `lib/bounded-excerpt.js`) so a wedged or adversarial CLI returning,
say, a 10,000-char `headRefOid` or `state` cannot inflate or line-inject the report through
`ids.live_head` / `ids.live`. `repair_candidates` (`{ kind, outcome_id, proposal }`) are
emitted for receipt→live gaps and live→receipt back-pointer discoveries. **Repair is out of
scope in this leaf** — `status` proposes text and performs NO mutation.

## Fail-closed exit codes (50-range)

| reason_code | exit | trigger |
| --- | --- | --- |
| `RECEIPT_NOT_FOUND` | 50 | no receipt for `--program-id` under the programs root |
| `RECEIPT_CORRUPT` | 51 | unparseable JSON, wrong `schema`, missing required keys, or `program_id` ≠ requested `--program-id` |
| `RECEIPT_REPO_MISMATCH` | 52 | receipt `repo.slug` does not match the current repo |

Usage errors exit `64`. `status` exits `0` whenever it successfully derives a view — even a
view full of `inconsistent`/`stale_missing` outcomes. Runtime mismatch and unreachable
Orca/GitHub do NOT fail the command; they degrade to diagnostics + `stale_missing`.

## Read-only guarantee

`status` performs NO mutation of any kind: no GitHub write, no relay manifest write, no Orca
mutating subcommand (`task-create`, `task-update`, `dispatch`, `terminal`, any `worktree`
subcommand, `reset`), and no receipt write. The tests prove it: the fake Orca fixture poisons
`reset`, `worktree`, and every mutating orchestration subcommand; the fake `gh` fixture
hard-fails on any non-read subcommand; and a test asserts the receipt bytes are identical
before and after `status`.
