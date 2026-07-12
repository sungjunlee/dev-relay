# Reconstructible receipt + read-only `status`

`run` persists a minimal, versioned **bridge receipt**; `status` is a strictly read-only
reconciler that derives a normalized program view from that receipt plus live relay
manifests, GitHub, and Orca runtime signals. Neither introduces a second program state
machine. This reference is the reviewer anchor for #945.

> This receipt is reconstructible coordination metadata, not a source of truth.

That exact sentence is carried verbatim in every receipt's top-level `note` field.

## Receipt path and slug derivation

```
~/.relay/programs/<repo-slug>/<program-id>/receipt.json
```

`<repo-slug>` is derived **identically** to relay's run-dir slug (see
`skills/relay-dispatch/scripts/manifest/paths.js` `getRepoSlug`): the lowercased,
dash-sanitized basename of the **canonicalized repo root** joined to the first 8 hex chars
of its `sha256`. relay-orca replicates the algorithm in `scripts/lib/repo-slug.js` — it does
**not** import cross-skill code. The canonical root is resolved the same way relay does (git
common dir → `realpath` of its parent), so a receipt lands under the same slug relay uses for
its run manifests. The programs root is overridable for tests via `RELAY_ORCA_PROGRAMS_ROOT`
(validated absolute path; invalid → ignored, default used).

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
- **Write points (bounded edit to `run`):** after task materialization, and after each
  successful dispatch verification (mapping-changing steps only). `run`'s report grows by
  exactly one key, `receipt_path`.

## `status` authority order (durable truth outranks runtime signals)

1. **Relay manifests** — read from `~/.relay/runs/<repo-slug>/` (overridable via
   `RELAY_ORCA_RUNS_ROOT`). The manifest `state` is the relay lifecycle truth.
2. **GitHub** — `gh issue view <n> --json state,stateReason` and read-only `gh pr view`
   queries (merge state + head), via an injectable gh binary (`--gh-bin` / env).
3. **Orca (runtime signals only)** — `status --json`, `orchestration task-list --json`,
   `gate-list --json`, `dispatch-show --task <id> --json`, all read-only, all through the
   probe's binary-resolution rules.

Orca task status and `worker_done` are lifecycle signals, **never** completion authority. An
outcome is `complete_with_evidence` ONLY when its live durable evidence holds — relay
manifest terminal AND expected PR merged AND tracker issue closed when closure is part of the
outcome (per the task kind's expected-evidence defaults in [task-kinds.md](task-kinds.md)).

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
terminal output, secrets, or env values; every subprocess-derived excerpt is bounded to
≤ 256 chars, the same rule the probe uses. `repair_candidates` (`{ kind, outcome_id,
proposal }`) are emitted for receipt→live gaps and live→receipt back-pointer discoveries.
**Repair is out of scope in this leaf** — `status` proposes text and performs NO mutation.

## Fail-closed exit codes (50-range)

| reason_code | exit | trigger |
| --- | --- | --- |
| `RECEIPT_NOT_FOUND` | 50 | no receipt for `--program-id` under the programs root |
| `RECEIPT_CORRUPT` | 51 | unparseable JSON, wrong `schema`, or missing required keys |
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
