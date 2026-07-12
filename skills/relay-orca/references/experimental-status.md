# relay-orca is EXPERIMENTAL and opt-in

relay-orca ships as an **experimental, opt-in** program-controller pilot (epic #941). It is
**not** part of the ordinary relay workflow and **not** an implicit dependency of `relay`,
`relay-fleet`, or any other relay skill. A fresh install can ignore it entirely; ordinary
relay use never routes through relay-orca.

## Installation and opt-in

- The full bundle (`npx skills add sungjunlee/dev-relay`) installs relay-orca alongside the
  other skills, but it stays dormant unless an operator **explicitly** invokes a relay-orca
  intent (`plan`, `run`, `status`, `resume`, `stop`).
- The OpenAI agent interface pins `allow_implicit_invocation: false` (see
  [../agents/openai.yaml](../agents/openai.yaml)), so no agent may auto-select relay-orca from
  ordinary relay, relay-fleet, delegation, implementation, or planning requests (D5).
- `plan` requires only Node.js 18+ and is read-only. `run` (#944) additionally requires the
  experimental Orca orchestration surface and is gated on the Orca capability probe; `status`
  (#945) is read-only but reads the same live runtime signals; the remaining runtime intents
  (`resume`/`stop`) stay contract-only until #946 delivers them.

## Pilot boundary

The first release is a supervised program-controller pilot, not a general autonomous software
factory. In v0:

- One active relay-orca program per Orca runtime; fail closed on ambiguous runtime-global
  state.
- Default concurrency 2, hard maximum 4.
- `stop` stops only the coordinator; it never kills relay runs or discards their durable
  state.
- Program truth stays in the tracker/dev-backlog plus relay manifests. relay-orca adds no new
  durable lifecycle state machine.
- `orca orchestration reset` is never run automatically.

See [accepted-program-schema.md](accepted-program-schema.md) for the input contract and
[task-kinds.md](task-kinds.md) for the operator/ownership invariants.
