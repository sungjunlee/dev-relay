# External-Tool Workflow Around Relay

Status: documentation. dev-relay does **not** hard-depend on gstack, superpowers, or Compound Engineering (CE). They are workflow shapes that operators sometimes use around relay; if they disappear tomorrow, dev-relay still ships PRs end-to-end.

This doc maps adjacent tools onto relay's lifecycle as defined in [`references/architecture.md`](../references/architecture.md). Companion to [`workflow-lanes.md`](./workflow-lanes.md): that one decides *which lane to use*; this one decides *which tools to invoke inside that lane*.

## TL;DR

- **gstack** = gstack lives one layer above relay: planning rooms (CEO / design / eng review), execution helpers (review, qa, ship), and post-mortem (retro). Most useful **before** dispatch and **after** merge. Inside a relay run, the relay reviewer remains the source of truth for the merge gate.
- **superpowers** = small, focused skills you reach for inside a single chat session: brainstorming, systematic debugging, TDD, verification, receiving-code-review. Most useful **inside fast/goal lanes**, or while drafting a relay rubric.
- **Compound Engineering (CE)** = specialist review and learning capture. Use it as a **second-pass independent reviewer** or as the structured retro that turns one PR's surprise into a saved memory. Do **not** treat it as a fourth orchestration layer parallel to dev-relay.

## Where Each Tool Fits

### gstack

| Phase | gstack skill | What it does | Relay interaction |
|-------|--------------|--------------|-------------------|
| Pre-plan | `office-hours` | Stress-tests demand and scope before you commit to building. | Run before opening an issue. Prevents over-scoped issues that later balloon mid-relay. |
| Pre-plan | `plan-ceo-review` | Founder-mode plan review: rethink the problem, expand scope when it makes a better product. | Run on the *issue body* or the *Done Criteria draft*. Output feeds relay-ready or relay-plan. |
| Pre-plan | `plan-eng-review` | Eng-manager-mode plan review: architecture, data flow, edge cases, test coverage. | Run on the dispatch prompt draft, especially for L/XL relay tasks. Output sharpens the rubric. |
| Pre-plan | `plan-design-review` | Designer's eye plan review. | Run on UI-bearing issues before relay-plan. Frontend rubric factors get tighter. |
| Inside dispatch | `qa`, `qa-only`, `browse` | Browser-driven QA for web changes. | Use **inside the dispatch worktree** if the executor needs to verify UI claims. Treat the QA report as Verification evidence; the relay reviewer still re-evaluates it independently. |
| Pre-merge | `review`, `design-review`, `cso` | Pre-landing diff review (structural, design, security). | Optional second-pass review **before** the relay reviewer signs off. If they catch something, file it as `changes_requested` evidence on the relay run, do not bypass the relay reviewer. |
| Pre-merge | `ship`, `land-and-deploy`, `canary`, `benchmark` | Ship + deploy + post-deploy verification. | Runs **after** relay-merge, on main. Relay does not know about deploy lanes; gstack does. |
| Post-merge | `retro`, `learn`, `document-release` | Weekly retro, learning capture, release docs. | Use after sprint close. Promotes durable findings into project memory or `docs/`. |

**Boundary**: gstack `plan-*-review` skills can produce *recommendations*; they cannot freeze Done Criteria. Only relay-ready / relay-plan freeze the anchor that the relay reviewer scores against. If gstack changes the plan after dispatch, you have to re-plan in relay (and re-persist the anchor).

### superpowers

| When | Skill | Use case | Relay interaction |
|------|-------|----------|-------------------|
| Drafting a rubric | `brainstorming`, `craft-blueprint`, `craft-prompt` | Explore intent, design the rubric shape. | Outputs feed the rubric YAML that relay-plan persists. The skill never sees the manifest. |
| Inside fast/goal lane | `tdd`, `verification`, `debugging` | Write failing tests first; verify a fix; investigate a flaky symptom. | If you escalate to relay later, attach the artifact path (test file, debug note) in the dispatch prompt's `Context` section. |
| Receiving review | `receiving-code-review` | Frame how to read tough review feedback before reacting. | Use after the relay reviewer returns `changes_requested`. Especially valuable when the verdict is on a quality-tier evaluated factor and your first instinct is to argue. |
| Across the board | `craft-tune`, `craft-reflect`, `craft-research` | Tighten an existing prompt; critique an artifact; survey prior art. | Use on the rubric or on the dispatch prompt template itself before locking it in. |

**Boundary**: superpowers skills are stateless prompts. They do not maintain a manifest, do not enforce gates, do not survive across sessions. dev-relay is the durable layer; superpowers is the in-session sharpening layer.

### Compound Engineering (CE)

CE is most useful here as **specialist review** and **structured learning capture**. Two patterns work well:

1. **Specialist second-pass on a relay PR.** After the relay reviewer returns PASS but before merge, a CE specialist (security, performance, type-design, silent-failure) re-reads the diff with a narrow lens. If they find something the relay reviewer missed, file it as a follow-up issue (do not block the current PR unless the finding is actually merge-blocking). This treats CE as a *defense-in-depth signal*, not a parallel orchestration layer.

2. **Structured retro / learning capture.** When a relay run produces a surprising lesson — a rubric pattern that worked, a planner mistake that recurred, a reviewer false-positive class — CE's structured-doc shape (problem → evidence → decision → memory) is good for promoting that lesson into either `_context.md`, a memory entry, or a new `references/rubric-pattern-*.md` file.

**Boundary**: do **not** treat CE as a fourth orchestration step between relay-review and explicit merge. That double-counts the review surface, doubles operator cost, and makes the merge gate ambiguous about whose verdict counts. The relay reviewer is the merge gate; CE is supplementary.

## Anti-Patterns to Avoid

- **Treating gstack `review` as the merge gate.** It is a pre-landing helper. The relay merge gate is `gate-check.js`, not gstack.
- **Re-running gstack `plan-eng-review` after dispatch.** If you want planning changes, escalate to a re-plan inside relay (re-persist the anchor). Otherwise the relay reviewer scores against a stale anchor and gives the wrong verdict.
- **Loading superpowers skills inside the dispatch worktree.** The executor runs directly on the trusted local host inside a retained worktree with tool networking enabled by default. Skills that assume orchestrator-session structure or arbitrary subagents won't behave identically there. Use superpowers in the orchestrator session (planning, reviewing reviews, deciding next dispatch).
- **Letting CE specialist findings silently rewrite the relay rubric.** If a CE specialist proposes a new factor, that's a planner-side decision: surface it, decide, then re-plan. Do not edit the persisted rubric out-of-band.
- **Coupling relay scripts to gstack/superpowers/CE internals.** Relay scripts must keep working without any of these tools installed. If a workflow needs them, document the workflow; don't import the dependency.

## Tool Independence Statement

dev-relay's contract surface — immutable run schema, append-only facts, derived actions, review verdict shape, and merge gate — is internal to dev-relay. None of it imports from gstack, superpowers, or CE. Removing any of those tools breaks no relay scripts and no relay tests.

This is intentional. The lifecycle contract has to outlive any one tool's UX choices.

## Related

- Lane policy: [`workflow-lanes.md`](./workflow-lanes.md)
- Epic: [#366](https://github.com/sungjunlee/dev-relay/issues/366)
- Companion: [#370](https://github.com/sungjunlee/dev-relay/issues/370) — borrowing Codex `/goal` completion-audit wording into the dispatch prompt (a similar "borrow a shape, not a dependency" move).
