# relay-orca install and operator guide (opt-in, experimental)

This guide is the opt-in installation and operator reference for relay-orca, written from the
2026-07-13 supervised pilot (epic #941, issue #948), not from aspiration. relay-orca is an
**experimental, explicit-only program-altitude coordinator**. It compiles an already-accepted
program contract into bounded, ordered Orca waves that supervise ordinary relay/relay-fleet
operators. It is **not** an autonomous software factory and **not** an implicit dependency of
ordinary relay use. See [experimental-status.md](experimental-status.md) for the pilot boundary
and [commands.md](commands.md) for the full flag tables referenced throughout.

## Opt-in install

- `npx skills add sungjunlee/dev-relay` installs relay-orca **alongside** the relay skills. No
  extra step installs it, and no step is required to keep it dormant.
- relay-orca is **never an implicit dependency** of `relay`, `relay-fleet`, `relay-plan`,
  `relay-dispatch`, `relay-review`, `relay-merge`, or any other relay skill. A fresh install can
  ignore it entirely; ordinary relay and relay-fleet install surfaces and behavior are unchanged.
- Invocation is **explicit-only**. The OpenAI agent interface pins
  `allow_implicit_invocation: false` ([../agents/openai.yaml](../agents/openai.yaml)); no agent
  may auto-select relay-orca from ordinary relay, relay-fleet, delegation, implementation, or
  planning requests.
- `plan` needs only Node.js 18+ and is read-only. The runtime intents (`run`, `status`,
  `resume`, `stop`) additionally require the experimental Orca orchestration surface and are
  gated on the capability probe.

## Explicit-only invocation — the five intents

All five intents are invoked directly, by hand. `plan` is read-only and needs no Orca. The four
runtime intents require probe admission first. Full flag tables: [commands.md](commands.md).

```bash
# plan — compile an accepted program into an immutable, read-only wave plan
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/plan.js" \
  --program-file /tmp/accepted-program.json --json

# admission — read-only capability probe (the ONLY admission authority; run before run/status/resume/stop)
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/probe-orca.js" --json

# run — admission-gated, provenance-injected dispatch to EXPLICIT operator terminals
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/run.js" \
  --program-file /tmp/accepted-program.json \
  --operator-handle term-a --operator-handle term-b --json

# status — read-only live reconciler over receipt + relay manifests + GitHub + Orca
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/status.js" --program-id epic-941 --json

# resume — crash-safe, reconcile-first, idempotent resumption (explicit handles only)
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/resume.js" \
  --program-id epic-941 --operator-handle term-a --json

# stop — coordinator-only stop record (see the recovery limitation below)
node "${RELAY_SKILL_ROOT:-skills}/relay-orca/scripts/stop.js" \
  --program-id epic-941 --reason "operator pause" --json
```

## Orca version and capability policy

- The targeted mid-2026 Orca CLI exposes **no version subcommand** (`orca version` →
  "Unknown command"; `orca --version` prints usage). Version is best-effort only and never
  blocks admission.
- The **capability probe is the ONLY admission authority**. A version string cannot prove that
  task creation, injected dispatch provenance, lifecycle IDs, and runtime readiness behave as
  relay-orca expects; the probe verifies each directly. Details:
  [capability-probe.md](capability-probe.md).
- The orchestration surface is experimental and evolving — **revalidate the probe on every Orca
  upgrade** before trusting a runtime intent.
- **Smoke mode is currently unusable against real Orca.** The pilot's `probe --smoke` run failed
  cleanup against the live runtime and required manual remediation plus a scoped reset (#1000).
  The supported admission path is the **read-only probe** (`probe-orca.js --json`); reserve
  `--smoke` for fake-runtime tests until the live smoke path is proven.

## Operator topology and the relay-owned worktree boundary

The supervision chain is exactly three layers deep:

```
coordinator (a terminal session running relay-orca's CLI scripts)
  └─ operator terminals (orca terminal create; each running a recognized agent CLI: claude, codex, …)
       └─ relay executors / reviewers (ordinary relay runs the operator drives)
```

- **Orca workers are relay operators, never direct code workers.** The coordinator and operator
  terminals never edit implementation code. **Relay owns all implementation worktrees and durable
  run manifests**; relay-orca never invokes any `orca worktree` subcommand.
- Each operator terminal must already be running an agent CLI: `orca orchestration dispatch
  --inject` requires a **live recognized agent**, and a bare/self-created terminal cannot accept
  an injection. Create one with `orca terminal create` and start the agent in it (empirically,
  starting the agent via a `terminal send` command is more reliable than `--command` at create
  time, which can race and exit).
- **Explicit `--operator-handle`s are required.** `run` and `resume` dispatch ONLY to handles you
  pass and **never self-create a terminal**. `run` with zero handles fails closed
  (`OPERATOR_DISPATCH_FAILED`, exit 44) before any mutation; `resume` fails closed
  (`RESUME_NO_OPERATOR_HANDLE`, exit 66) with zero mutation. A handle carries at most one active
  task. See [operator-dispatch.md](operator-dispatch.md).

## One active program per runtime (v0) and reset discipline

- v0 supports **one active relay-orca program per Orca runtime**; admission fails closed on
  ambiguous runtime-global state.
- The probe blocks admission on any **active** task (`pending`/`ready`/`dispatched`/`blocked`) or
  any **live gate** (`EXISTING_ORCHESTRATION_STATE`); historical `completed`/`failed` task rows
  are ignored so they cannot brick later probes.
- Orca exposes **no per-task delete**, and a finished or interrupted program leaves task rows —
  and any exit gate it created — in the runtime. Because live gates always block admission, a
  fresh program on the same runtime generally requires clearing the prior program's leftovers.
- **Between programs the operator manually runs a scoped `orca orchestration reset --tasks`**, and
  only after enumerating that every remaining task belongs to the finished program. **relay-orca
  itself never runs `orca orchestration reset`** — not on admission failure, smoke cleanup, or any
  other path.

## Recovery and manual-cleanup limitations (open follow-ups from the 2026-07-13 pilot)

These are honest, open follow-ups surfaced by the pilot; they are not yet fixed:

- **`stop` cannot currently succeed in the v0 topology (#1005).** `stop`'s only mutation,
  `orca orchestration run-stop`, assumes an always-on Orca coordinator loop that the stateless-CLI
  v0 model never starts, so it exits 65 (`COORDINATOR_STOP_FAILED`) and writes no stop record. The
  fail-closed behavior is honest, but the intent — durably recording an operator interruption — is
  unreachable today.
- **Operator-driven outcomes need a supervised receipt-mapping reconcile before they classify
  complete (#1008).** `run` writes the receipt before the operator's relay run exists, and no code
  path consumes the operator's completion payload back into the receipt, so `relay_ids.run` stays
  null and the outcome reads `running` forever. Verified-evidence-first recipe: **live-verify**
  the relay manifest is terminal, the PR is MERGED, and the issue is CLOSED, **then** atomically
  write the confirmed `relay_ids.run` into the receipt. Only after that mapping does the #945
  evidence classifier report `complete_with_evidence`.
- **Waves beyond wave 1 need a supervised manual dispatch (#1009).** No shipped code path advances
  a program past wave 1: `run` dispatches wave 1 only (and cannot re-run under empty-runtime
  admission), `resume` re-dispatches only crash-lost wave-1 outcomes, and the #947 gate/completion
  modes are read-only. The supervised workaround is to replay `run`'s exact verified sequence for
  the next-wave task — `dispatch --inject` → `dispatch-show` provenance verify → `terminal send`
  prompt — then reconcile the receipt per #1008.

`resume` and `stop` never reset Orca, delete a task/worktree/branch/PR, or force-close a relay
run on any path. Manual decision recovery: [recovery.md](recovery.md).

## Agent-engine-agnostic routing

- Engine selection lives in **relay route configuration** (`~/.relay/routes.json` / policy
  defaults), resolved at relay dispatch time. It **never** appears in the accepted-program JSON or
  in the operator prompts: the program schema carries no execution engine field, and prompts
  source only an operator name and mode from `recommended_route`.
- Because the operator contract is engine-independent, the same program runs across supported
  agent CLIs with no engine-specific skill branch. In the pilot, operator A ran `claude` and
  operator B ran `codex` under an **identical operator contract**; each drove a full ordinary
  relay cycle (readiness → plan → dispatch → review → merge) and shipped a merged PR, differing
  only in the relay route resolved for its underlying dispatch.

## This is a supervised pilot, not a software factory

relay-orca v0 is a **supervised program-controller pilot**, not a guaranteed autonomous software
factory. It preserves relay's lifecycle truth (durable relay manifests, PRs, and exit-gate
evidence — `worker_done` is never completion authority) and adds no new orchestration service to
operate. Program completion is proven only from live relay/GitHub/gate evidence, and several
steps above still require a supervised operator in the loop. Treat every run accordingly.
